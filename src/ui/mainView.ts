export type MainView = ReturnType<typeof renderMainView>;

export function renderMainView(iconUrl: string) {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
    <main class="shell">
      <header>
        <div class="brand"><img class="brand-mark" src="${iconUrl}" alt=""><span>SpeakIt</span></div>
        <span class="local-pill"><i></i> 100% local</span>
      </header>
      <section class="hero">
        <div class="eyebrow">VOICE TO TEXT, INSTANTLY</div>
        <h1>Say it.<br><em>We'll type it.</em></h1>
        <p>Focus any text box, hold your shortcut, and speak. SpeakIt puts the words exactly where your cursor is.</p>
        <button id="record" class="record-button" type="button" aria-label="Hold to test dictation"><span class="mic">●</span></button>
        <div id="status" class="status">Focus a text box, then hold the shortcut</div>
        <div id="shortcut-display" class="shortcut"></div>
      </section>
      <section class="settings-card">
        <div><strong>Dictation shortcut</strong><span>Click the field, then press your preferred shortcut.</span></div>
        <button id="shortcut-editor" class="shortcut-editor" type="button">⌘ ⇧ Space</button>
      </section>
      <section class="settings-card diagnostics-card">
        <div><strong>System diagnostics</strong><span>Test permissions, microphone input, model, and paste logging.</span></div>
        <div class="diagnostic-actions"><button id="run-diagnostics" type="button">Run check</button><button id="copy-diagnostics" type="button">Copy</button></div>
        <pre id="diagnostic-output" class="hidden"></pre>
      </section>
      <section class="result-card">
        <div class="result-heading"><span>Latest dictation</span><button id="copy" type="button">Copy</button></div>
        <p id="transcript" class="placeholder">Your latest transcription will appear here.</p>
      </section>
      <footer><span>No cloud. No account. No subscription.</span><span id="model-state">Checking speech model…</span></footer>
    </main>
    <div id="permission-setup" class="permission-setup">
      <section class="permission-panel">
        <img class="permission-logo" src="${iconUrl}" alt="SpeakIt">
        <div class="eyebrow">QUICK SETUP</div>
        <h2>Give SpeakIt permission<br>to listen and type.</h2>
        <p>Both permissions stay on your Mac and are required before dictation can work.</p>
        <button id="enable-mic" class="permission-row" type="button">
          <span class="permission-icon">◉</span><span><strong>Microphone</strong><small>Record only while your shortcut is held</small></span><b id="mic-check">Enable</b>
        </button>
        <button id="enable-access" class="permission-row" type="button">
          <span class="permission-icon">⌨</span><span><strong>Accessibility</strong><small>Find your active app and paste your words</small></span><b id="access-check">Enable</b>
        </button>
        <button id="finish-setup" class="finish-setup" type="button" disabled>Finish setup</button>
        <div id="install-warning" class="install-warning hidden"></div>
        <small class="permission-help">After enabling Accessibility in System Settings, return here. SpeakIt checks automatically.</small>
      </section>
    </div>
    <div id="model-setup" class="permission-setup model-setup">
      <section class="permission-panel">
        <img class="permission-logo" src="${iconUrl}" alt="SpeakIt">
        <div class="eyebrow">LOCAL SPEECH MODEL</div>
        <h2>Download transcription<br>before you begin.</h2>
        <p>SpeakIt needs the free Whisper small English model. It is about 466 MB and stays entirely on this Mac.</p>
        <div class="download-track"><i id="download-progress"></i></div>
        <div id="download-label" class="download-label">Ready to download</div>
        <button id="download-model" class="finish-setup" type="button">Download model</button>
        <small class="permission-help">Dictation remains disabled until the model is completely downloaded.</small>
      </section>
    </div>`;

  return {
    recordButton: element<HTMLButtonElement>("#record"),
    statusLabel: element<HTMLDivElement>("#status"),
    transcript: element<HTMLParagraphElement>("#transcript"),
    copyButton: element<HTMLButtonElement>("#copy"),
    modelState: element<HTMLSpanElement>("#model-state"),
    shortcutEditor: element<HTMLButtonElement>("#shortcut-editor"),
    shortcutDisplay: element<HTMLDivElement>("#shortcut-display"),
    permissionSetup: element<HTMLDivElement>("#permission-setup"),
    enableMic: element<HTMLButtonElement>("#enable-mic"),
    enableAccess: element<HTMLButtonElement>("#enable-access"),
    micCheck: element<HTMLElement>("#mic-check"),
    accessCheck: element<HTMLElement>("#access-check"),
    finishSetup: element<HTMLButtonElement>("#finish-setup"),
    installWarning: element<HTMLDivElement>("#install-warning"),
    modelSetup: element<HTMLDivElement>("#model-setup"),
    downloadModelButton: element<HTMLButtonElement>("#download-model"),
    downloadProgress: element<HTMLElement>("#download-progress"),
    downloadLabel: element<HTMLDivElement>("#download-label"),
    runDiagnosticsButton: element<HTMLButtonElement>("#run-diagnostics"),
    copyDiagnosticsButton: element<HTMLButtonElement>("#copy-diagnostics"),
    diagnosticOutput: element<HTMLPreElement>("#diagnostic-output"),
  };
}

function element<T extends Element>(selector: string) {
  return document.querySelector<T>(selector)!;
}
