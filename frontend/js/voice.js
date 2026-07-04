// ========== 语音输入（录音 + 实时转写） ==========
var elVoiceBtn = $("#voice-input-btn");
var elVoiceStatus = $("#voice-status");
var elVoicePreview = $("#voice-preview");
var elVoiceDuration = $("#voice-duration");
var elVoiceAudio = $("#voice-audio");
var elVoiceDiscard = $("#voice-discard");

var recognition = null;
var mediaRecorder = null;
var mediaStream = null;
var audioChunks = [];
var recordedAudioBlob = null;
var recordedAudioBase64 = null;
var recordedAudioMimeType = "";
var isRecording = false;
var finalTranscript = "";
var recordStartTime = 0;
var recordTimerHandle = null;

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function updateRecordDuration() {
  const elapsed = Date.now() - recordStartTime;
  elVoiceDuration.textContent = "⏱️ " + formatDuration(elapsed);
}

function showVoiceStatus(text, type = "info") {
  elVoiceStatus.textContent = text;
  elVoiceStatus.hidden = false;
  elVoiceStatus.className =
    "voice-status" + (type !== "info" ? " " + type : "");
}

function hideVoiceStatus() {
  elVoiceStatus.hidden = true;
}

function clearRecordedAudio() {
  recordedAudioBlob = null;
  recordedAudioBase64 = null;
  recordedAudioMimeType = "";
  elVoicePreview.hidden = true;
  elVoiceAudio.src = "";
  if (recordTimerHandle) {
    clearInterval(recordTimerHandle);
    recordTimerHandle = null;
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result.split(",")[1];
      resolve(base64data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function initSpeechRecognition() {
  if (recognition) return true;
  const SpeechRecognition =
    window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return false;
  recognition = new SpeechRecognition();
  recognition.lang = "zh-CN";
  recognition.interimResults = true;
  recognition.continuous = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let interimTranscript = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript;
      } else {
        interimTranscript += transcript;
      }
    }
    const fullText = finalTranscript + interimTranscript;
    elManualInputText.value = fullText;
    if (interimTranscript) {
      showVoiceStatus("🎤 识别中: " + interimTranscript);
    } else {
      showVoiceStatus(
        "🎤 正在聆听... " + formatDuration(Date.now() - recordStartTime),
      );
    }
  };

  recognition.onerror = (event) => {
    console.error("Speech recognition error:", event.error);
    if (event.error === "no-speech" || event.error === "aborted") return;
    let errorMsg = "语音识别出错";
    switch (event.error) {
      case "not-allowed":
      case "service-not-allowed":
        errorMsg = "❌ 麦克风权限被拒绝";
        break;
      case "audio-capture":
        errorMsg = "❌ 未检测到麦克风设备";
        break;
      case "network":
        errorMsg = "⚠️ 语音转文字需要网络，录音仍在保存中";
        break;
      default:
        errorMsg = "⚠️ 识别问题: " + event.error + "（录音仍在保存）";
    }
    showVoiceStatus(errorMsg, "error");
  };

  recognition.onend = () => {
    if (isRecording) {
      try {
        recognition.start();
      } catch (e) {}
    }
  };

  return true;
}

async function startRecording() {
  clearRecordedAudio();
  finalTranscript = elManualInputText.value
    ? elManualInputText.value + " "
    : "";
  elManualInputText.value = finalTranscript;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    showVoiceStatus("❌ 无法访问麦克风: " + e.message, "error");
    return;
  }

  let mimeType = "";
  const preferredTypes = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  for (const t of preferredTypes) {
    if (MediaRecorder.isTypeSupported(t)) {
      mimeType = t;
      break;
    }
  }
  if (!mimeType) {
    showVoiceStatus("❌ 您的浏览器不支持音频录制", "error");
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    return;
  }

  audioChunks = [];
  mediaRecorder = new MediaRecorder(mediaStream, { mimeType });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = async () => {
    const blob = new Blob(audioChunks, { type: mimeType });
    recordedAudioBlob = blob;
    recordedAudioMimeType = mimeType.split(";")[0];
    recordedAudioBase64 = await blobToBase64(blob);
    elVoiceAudio.src = URL.createObjectURL(blob);
    elVoicePreview.hidden = false;
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  };
  mediaRecorder.start(1000);

  recordStartTime = Date.now();
  recordTimerHandle = setInterval(updateRecordDuration, 200);
  updateRecordDuration();

  isRecording = true;
  elVoiceBtn.classList.add("recording");
  elVoiceBtn.textContent = "⏹️";

  if (initSpeechRecognition()) {
    try {
      recognition.start();
    } catch (e) {
      showVoiceStatus("🎤 正在录音...（语音转文字不可用，但录音会保存）");
    }
  } else {
    showVoiceStatus("🎤 正在录音...（浏览器不支持实时转文字，但录音会保存）");
  }
}

async function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  elVoiceBtn.classList.remove("recording");
  elVoiceBtn.textContent = "🎤";
  if (recordTimerHandle) {
    clearInterval(recordTimerHandle);
    recordTimerHandle = null;
  }

  const stopped = new Promise((resolve) => {
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.onstop = async () => {
        const blob = new Blob(audioChunks, { type: mediaRecorder.mimeType });
        recordedAudioBlob = blob;
        recordedAudioMimeType = mediaRecorder.mimeType.split(";")[0];
        recordedAudioBase64 = await blobToBase64(blob);
        elVoiceAudio.src = URL.createObjectURL(blob);
        elVoicePreview.hidden = false;
        if (mediaStream) mediaStream.getTracks().forEach((t) => t.stop());
        mediaStream = null;
        resolve();
      };
      mediaRecorder.stop();
    } else {
      resolve();
    }
  });
  if (recognition) {
    try {
      recognition.stop();
    } catch (e) {}
  }
  await stopped;

  const duration = Date.now() - recordStartTime;
  elVoiceDuration.textContent = "⏱️ " + formatDuration(duration);
}

elVoiceBtn.addEventListener("click", () => {
  if (isRecording) {
    stopRecording();
  } else {
    startRecording();
  }
});

elVoiceDiscard.addEventListener("click", () => {
  clearRecordedAudio();
  showVoiceStatus("🗑️ 已丢弃录音", "info");
  setTimeout(hideVoiceStatus, 1500);
});

elManualInputDialog.addEventListener("close", () => {
  if (isRecording) stopRecording();
  hideVoiceStatus();
});
