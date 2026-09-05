export type MainView = ReturnType<typeof renderMainView>;

export function renderMainView(iconUrl: string) {
  const app = document.querySelector<HTMLDivElement>("#app")!;
  app.innerHTML = `
    <button id="nav-backdrop" class="nav-backdrop" type="button" aria-label="Close navigation"></button>
    <aside id="side-nav" class="side-nav" aria-hidden="true">
      <div class="side-nav-heading">
        <div class="brand"><img class="brand-mark" src="${iconUrl}" alt=""><span>SpeakIt</span></div>
        <button id="nav-close" class="nav-close" type="button" aria-label="Close navigation">×</button>
      </div>
      <nav aria-label="SpeakIt navigation">
        <button id="nav-home" class="nav-item active" type="button"><span>⌂</span> Home</button>
        <button id="nav-models" class="nav-item" type="button"><span>◉</span> Speech models</button>
        <button id="nav-history" class="nav-item" type="button"><span>↶</span> History</button>
      </nav>
      <p>Your last five dictations stay only on this Mac.</p>
    </aside>
    <main class="shell">
      <header>
        <div class="header-brand">
          <button id="nav-open" class="nav-open" type="button" aria-label="Open navigation" aria-expanded="false"><i></i><i></i><i></i></button>
          <div class="brand"><img class="brand-mark" src="${iconUrl}" alt=""><span>SpeakIt</span></div>
        </div>
        <span class="local-pill"><i></i> 100% local</span>
      </header>
      <div id="home-view" class="page-view">
        <section class="hero">
          <div class="eyebrow">VOICE TO TEXT, INSTANTLY</div>
          <h1>Say it.<br><em>We'll type it.</em></h1>
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
      </div>
      <section id="history-view" class="history-page hidden">
        <div class="history-page-title"><div><div class="eyebrow">LOCAL HISTORY</div><h2>Recent dictations</h2></div><span>Last 5 · Audio is never saved</span></div>
        <div class="result-card"><ul id="history" aria-label="Recent dictations"></ul></div>
      </section>
      <section id="models-view" class="models-page hidden">
        <div class="history-page-title"><div><div class="eyebrow">SPEECH SETTINGS</div><h2>Speech models</h2></div><span>Runs entirely on this Mac</span></div>
        <div class="model-list">
          <article id="canary-card" class="model-card">
            <div class="model-icon">◉</div>
            <div class="model-details"><div class="model-title"><strong>Canary 180M Flash</strong><span class="recommended-badge">Default</span></div><p>Fast, multilingual dictation with punctuation.</p><div class="language-list"><span>English</span><span>German</span><span>French</span><span>Spanish</span></div></div>
            <div class="model-actions"><small id="canary-state">Checking…</small><button id="select-canary" type="button">Select</button><button id="download-canary" class="hidden" type="button">Download · 214 MB</button></div>
          </article>
          <article id="whisper-card" class="model-card">
            <div class="model-icon">W</div>
            <div class="model-details"><div class="model-title"><strong>Whisper small.en</strong></div><p>Dependable English transcription with a larger local model.</p><div class="language-list"><span>English</span></div></div>
            <div class="model-actions"><small id="whisper-state">Checking…</small><button id="select-whisper" type="button">Select</button><button id="download-whisper" class="hidden" type="button">Download · 466 MB</button></div>
          </article>
        </div>
        <p class="model-note">Only one model is active at a time. Downloaded models remain available offline.</p>
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
        <p id="model-setup-copy">SpeakIt uses Canary Flash by default. Its free model is about 214 MB and stays entirely on this Mac.</p>
        <div class="download-track"><i id="download-progress"></i></div>
        <div id="download-label" class="download-label">Ready to download</div>
        <button id="download-model" class="finish-setup" type="button">Download model</button>
        <small class="permission-help">Dictation remains disabled until the model is completely downloaded.</small>
      </section>
    </div>`;

  return {
    recordButton: element<HTMLButtonElement>("#record"),
    statusLabel: element<HTMLDivElement>("#status"),
    history: element<HTMLUListElement>("#history"),
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
    navBackdrop: element<HTMLButtonElement>("#nav-backdrop"),
    sideNav: element<HTMLElement>("#side-nav"),
    navOpen: element<HTMLButtonElement>("#nav-open"),
    navClose: element<HTMLButtonElement>("#nav-close"),
    navHome: element<HTMLButtonElement>("#nav-home"),
    navModels: element<HTMLButtonElement>("#nav-models"),
    navHistory: element<HTMLButtonElement>("#nav-history"),
    homeView: element<HTMLDivElement>("#home-view"),
    historyView: element<HTMLElement>("#history-view"),
    modelsView: element<HTMLElement>("#models-view"),
    canaryCard: element<HTMLElement>("#canary-card"),
    whisperCard: element<HTMLElement>("#whisper-card"),
    canaryState: element<HTMLElement>("#canary-state"),
    whisperState: element<HTMLElement>("#whisper-state"),
    selectCanary: element<HTMLButtonElement>("#select-canary"),
    selectWhisper: element<HTMLButtonElement>("#select-whisper"),
    downloadCanary: element<HTMLButtonElement>("#download-canary"),
    downloadWhisper: element<HTMLButtonElement>("#download-whisper"),
    modelSetupCopy: element<HTMLParagraphElement>("#model-setup-copy"),
  };
}

function element<T extends Element>(selector: string) {
  return document.querySelector<T>(selector)!;
}
