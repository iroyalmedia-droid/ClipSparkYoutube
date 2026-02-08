const generateBtn = document.getElementById("generateBtn");
const sampleBtn = document.getElementById("sampleBtn");
const exportBtn = document.getElementById("exportBtn");
const urlInput = document.getElementById("urlInput");
const goalSelect = document.getElementById("goalSelect");
const lengthSelect = document.getElementById("lengthSelect");
const languageSelect = document.getElementById("languageSelect");
const subtitleStyle = document.getElementById("subtitleStyle");
const burnInToggle = document.getElementById("burnInToggle");
const emojiToggle = document.getElementById("emojiToggle");
const speakerToggle = document.getElementById("speakerToggle");
const platformTikTok = document.getElementById("platformTikTok");
const platformShorts = document.getElementById("platformShorts");
const platformReels = document.getElementById("platformReels");
const statusText = document.getElementById("statusText");
const platformSummary = document.getElementById("platformSummary");
const subtitlePreview = document.getElementById("subtitlePreview");
const previewNotes = document.getElementById("previewNotes");
const pipelineSteps = Array.from(document.querySelectorAll(".pipeline-step"));
const outputCards = Array.from(document.querySelectorAll(".output-card"));
const outputTitles = Array.from(document.querySelectorAll(".output-title"));
const outputDescriptions = Array.from(document.querySelectorAll(".output-desc"));
const outputDurations = Array.from(document.querySelectorAll("[data-duration]"));
const subtitleBlocks = Array.from(document.querySelectorAll(".subtitle-lines"));

let pollTimer = null;
let activeJobId = null;

const styleClasses = ["style-kinetic", "style-minimal", "style-karaoke", "style-bold"];

const goalCopy = {
  highlights: {
    titles: ["Highlight #1 • Hook", "Highlight #2 • Reaction", "Highlight #3 • Payoff"],
    descriptions: [
      "Auto-crop + caption emphasis ready.",
      "Punchy clip with peak audience spike.",
      "Best replayed moment with subtitles."
    ],
  },
  tutorial: {
    titles: ["Highlight #1 • Step 1", "Highlight #2 • Key tip", "Highlight #3 • Result"],
    descriptions: [
      "Quick setup with on-screen captions.",
      "Core insight with zoom on speaker.",
      "Before/after reveal ready to post."
    ],
  },
  story: {
    titles: ["Highlight #1 • Setup", "Highlight #2 • Turning point", "Highlight #3 • Resolution"],
    descriptions: [
      "Story hook with kinetic captions.",
      "Mid-arc tension with dramatic pacing.",
      "Ending beat with stacked subtitles."
    ],
  },
};

const lengthDurations = {
  short: ["0:22", "0:18", "0:26"],
  medium: ["0:34", "0:38", "0:41"],
  long: ["0:52", "0:49", "0:57"],
};

const platformMap = {
  tiktok: platformTikTok,
  shorts: platformShorts,
  reels: platformReels,
};

function setStatus(message, tone = "idle") {
  statusText.textContent = message;
  statusText.setAttribute("data-tone", tone);
}

function setStepState(step, state) {
  step.classList.remove("is-active", "is-done");
  if (state === "active") {
    step.classList.add("is-active");
  }
  if (state === "done") {
    step.classList.add("is-done");
  }
}

function resetPipeline() {
  pipelineSteps.forEach((step) => setStepState(step, "idle"));
}

function updatePipeline(stepIndex, status) {
  pipelineSteps.forEach((step, index) => {
    if (index < stepIndex) {
      setStepState(step, "done");
    } else if (index === stepIndex && status === "processing") {
      setStepState(step, "active");
    } else if (status === "done") {
      setStepState(step, "done");
    } else {
      setStepState(step, "idle");
    }
  });
}

function updatePlatformSummary() {
  const active = Object.entries(platformMap)
    .filter(([, checkbox]) => checkbox.checked)
    .map(([platform]) => platform);

  const labelMap = {
    tiktok: "TikTok",
    shorts: "Shorts",
    reels: "Reels",
  };

  if (!active.length) {
    platformSummary.textContent = "No outputs selected";
    return;
  }

  platformSummary.textContent = `Outputs: ${active.map((item) => labelMap[item]).join(", ")}`;
}

function updatePlatformVisibility() {
  outputCards.forEach((card) => {
    const platform = card.dataset.platform;
    const checkbox = platformMap[platform];
    card.classList.toggle("is-disabled", !checkbox.checked);
  });
}

function updateSubtitleStyle() {
  const style = subtitleStyle.value;
  subtitlePreview.classList.remove(...styleClasses);
  subtitlePreview.classList.add(`style-${style}`);
  subtitleBlocks.forEach((block) => {
    block.classList.remove(...styleClasses);
    block.classList.add(`style-${style}`);
  });
}

function updatePreviewNotes() {
  const burnIn = burnInToggle.checked ? "Burn-in captions" : "Sidecar captions";
  const emoji = emojiToggle.checked ? "Emoji emphasis on" : "Emoji emphasis off";
  const speaker = speakerToggle.checked ? "Speaker labels on" : "Speaker labels off";
  previewNotes.textContent = `${burnIn} • ${speaker} • ${emoji}`;
}

function updateOutputCopy() {
  const goal = goalSelect.value;
  const copy = goalCopy[goal];
  if (!copy) return;
  outputTitles.forEach((title, index) => {
    title.textContent = copy.titles[index] || title.textContent;
  });
  outputDescriptions.forEach((desc, index) => {
    desc.textContent = copy.descriptions[index] || desc.textContent;
  });
}

function updateDurations() {
  const length = lengthSelect.value;
  const durations = lengthDurations[length] || lengthDurations.short;
  outputDurations.forEach((node, index) => {
    node.textContent = durations[index] || node.textContent;
  });
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function pollJob(jobId) {
  try {
    const res = await fetch(`/api/jobs/${jobId}`);
    if (!res.ok) throw new Error("Unable to fetch job status.");
    const data = await res.json();

    if (data.status === "processing") {
      setStatus(data.message || "Processing...", "work");
      updatePipeline(data.step || 0, "processing");
      return;
    }

    if (data.status === "done") {
      setStatus("Highlights ready. Download the export package.", "success");
      updatePipeline(4, "done");
      exportBtn.disabled = false;
      stopPolling();
      return;
    }

    if (data.status === "error") {
      setStatus(data.message || "Processing failed.", "error");
      updatePipeline(0, "idle");
      stopPolling();
    }
  } catch (error) {
    setStatus(error.message || "Unable to reach server.", "error");
    stopPolling();
  }
}

async function startPipeline() {
  const url = urlInput.value.trim();
  if (!url) {
    setStatus("Add a YouTube URL to begin.", "error");
    return;
  }

  generateBtn.disabled = true;
  exportBtn.disabled = true;
  resetPipeline();
  setStatus("Starting highlight job...", "work");

  const payload = {
    url,
    goal: goalSelect.value,
    length: lengthSelect.value,
    subtitleStyle: subtitleStyle.value,
    burnIn: burnInToggle.checked,
    language: languageSelect?.value === "auto" ? undefined : languageSelect?.value,
    platforms: {
      tiktok: platformTikTok.checked,
      shorts: platformShorts.checked,
      reels: platformReels.checked,
    },
  };

  try {
    const res = await fetch("/api/highlights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) {
      throw new Error(data.error || "Unable to start job.");
    }

    activeJobId = data.jobId;
    updatePipeline(0, "processing");

    stopPolling();
    pollTimer = setInterval(() => pollJob(activeJobId), 1200);
    pollJob(activeJobId);
  } catch (error) {
    setStatus(error.message || "Unable to start job.", "error");
    generateBtn.disabled = false;
  } finally {
    generateBtn.disabled = false;
  }
}

function loadSample() {
  urlInput.value = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  startPipeline();
}

function exportPackage() {
  if (!activeJobId) {
    setStatus("Run a highlight job first.", "error");
    return;
  }
  window.location.href = `/api/jobs/${activeJobId}/download`;
}

subtitleStyle.addEventListener("change", updateSubtitleStyle);
burnInToggle.addEventListener("change", updatePreviewNotes);
emojiToggle.addEventListener("change", updatePreviewNotes);
speakerToggle.addEventListener("change", updatePreviewNotes);

platformTikTok.addEventListener("change", () => {
  updatePlatformVisibility();
  updatePlatformSummary();
});
platformShorts.addEventListener("change", () => {
  updatePlatformVisibility();
  updatePlatformSummary();
});
platformReels.addEventListener("change", () => {
  updatePlatformVisibility();
  updatePlatformSummary();
});

lengthSelect.addEventListener("change", updateDurations);
goalSelect.addEventListener("change", updateOutputCopy);

sampleBtn.addEventListener("click", loadSample);
generateBtn.addEventListener("click", startPipeline);
exportBtn.addEventListener("click", exportPackage);

exportBtn.disabled = true;

updateSubtitleStyle();
updatePreviewNotes();
updatePlatformSummary();
updatePlatformVisibility();
updateDurations();
updateOutputCopy();
