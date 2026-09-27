(() => {
  "use strict";

  // ===================== Config =====================
  const WORKER_URL = "https://astral-proxy.leoneghertu2.workers.dev";
  const MODEL_ID = "stealth/space-bunny-alpha";
  const MODEL_LABEL = "Space Bunny Alpha";
  const CONTROL_TOKEN = "[[END_CONVERSATION]]";
  const MAX_READABLE_BYTES = 2 * 1024 * 1024;
  const VISUAL_DAILY_TOKEN_REFERENCE = 50000;
  const STORAGE_KEY = "astral_state_v1";

  const SYSTEM_PROMPT = `You are Astral, a coding agent and general-purpose AI assistant.
Treat people politely and respectfully.
Do not use emojis unless the user explicitly asks you to use them.
Be helpful, clear, and honest about your capabilities.
Never pretend that you performed an action, searched something, used a tool, accessed a file, or completed an operation when you did not actually do so.
When users provide code or files, analyze them carefully and explain your reasoning clearly.
If the user uses racial slurs, promotes hateful abuse, discusses child abuse in an inappropriate manner, or engages in other clearly inappropriate behavior, redirect the conversation toward a safe and appropriate subject.
For the first occurrence, give a clear warning and redirect them.
If the behavior continues, give a second warning explaining that continued inappropriate behavior will cause the conversation to end.
If the behavior continues after the second warning, output the control token:
${CONTROL_TOKEN}
and end the conversation.
If the behavior is severe enough that continuing would itself be inappropriate, Astral may end the conversation immediately.
Do not insult, threaten, humiliate, or antagonize the user.
The purpose of warnings is to redirect the conversation, not punish the user.
Never put ${CONTROL_TOKEN} inside a code block when intending to end a conversation.
When ending a conversation, do not continue responding after the control token.`;

  const EXT_LANG = {
    py: "python", lua: "lua", luau: "lua", js: "javascript", mjs: "javascript",
    ts: "typescript", tsx: "typescript", html: "xml", htm: "xml", css: "css",
    json: "json", xml: "xml", sh: "bash", bash: "bash", sql: "sql", md: "markdown",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", java: "java",
    rs: "rust", go: "go", txt: "plaintext", csv: "plaintext",
  };

  const TEXT_EXTENSIONS = new Set([
    ...Object.keys(EXT_LANG), "yml", "yaml", "toml", "ini", "cfg", "env",
  ]);

  // ===================== State =====================
  let state = loadState();
  let activeConversationId = state.conversations[0]?.id || null;
  let sidebarOpen = state.settings.keepSidebarOpen;
  let pendingAttachments = [];
  let pendingDeleteId = null;
  let confirmHandler = null;

  function defaultState() {
    return {
      conversations: [],
      settings: {
        keepSidebarOpen: false,
        theme: "space",
        customTheme: {
          bg: "#0a0a0d",
          accent: "#5b8cff",
          switchColor: "#5b8cff",
          pulse: "#ff78c8",
          pulsesEnabled: true
        },
        apiKey: "",
        memoryEnabled: true,
        memoryPreferences: "",
        memorySummary: "",
        developerMode: false,
      },
      tokenUsage: {
        date: todayKey(),
        estimated: 0,
        exact: 0,
        hasExact: false
      },
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return defaultState();

      const parsed = JSON.parse(raw);
      const merged = { ...defaultState(), ...parsed };

      merged.settings = {
        ...defaultState().settings,
        ...(parsed.settings || {})
      };

      merged.settings.customTheme = {
        ...defaultState().settings.customTheme,
        ...(parsed.settings?.customTheme || {})
      };

      if (!merged.tokenUsage || merged.tokenUsage.date !== todayKey()) {
        merged.tokenUsage = {
          date: todayKey(),
          estimated: 0,
          exact: 0,
          hasExact: false
        };
      }

      return merged;
    } catch {
      return defaultState();
    }
  }

  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      showToast("Local storage is full — older chats may not save. Try clearing some.");
    }
  }

  function todayKey() {
    return new Date().toISOString().slice(0, 10);
  }

  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function getActiveConversation() {
    return state.conversations.find((c) => c.id === activeConversationId) || null;
  }

  // ===================== DOM refs =====================
  const el = (id) => document.getElementById(id);

  const app = el("app");
  const homeScreen = el("homeScreen");
  const chatScreen = el("chatScreen");
  const messagesEl = el("messages");
  const composerForm = el("composerForm");
  const composerInput = el("composerInput");
  const sendBtn = el("sendBtn");
  const attachBtn = el("attachBtn");
  const fileInput = el("fileInput");
  const fileChipsEl = el("fileChips");
  const fileErrorEl = el("fileError");
  const sidebar = el("sidebar");
  const sidebarOverlay = el("sidebarOverlay");
  const sidebarToggle = el("sidebarToggle");
  const conversationListEl = el("conversationList");
  const newChatBtn = el("newChatBtn");
  const settingsBtn = el("settingsBtn");
  const settingsModal = el("settingsModal");
  const devInfo = el("devInfo");
  const devTokens = el("devTokens");
  const endedBanner = el("endedBanner");
  const endedNewChat = el("endedNewChat");
  const deleteModal = el("deleteModal");
  const confirmModal = el("confirmModal");
  const toastEl = el("toast");

  // ===================== Markdown rendering =====================
  function renderMarkdownInto(container, text) {
    const rawHtml = marked.parse(text || "", {
      breaks: true,
      gfm: true
    });

    const clean = DOMPurify.sanitize(rawHtml, {
      ADD_ATTR: ["target", "rel"]
    });

    container.innerHTML = clean;
    enhanceCodeBlocks(container);

    container.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer");
    });
  }

  function enhanceCodeBlocks(container) {
    container.querySelectorAll("pre > code").forEach((codeEl) => {
      if (codeEl.closest(".code-block")) return;

      const langMatch = codeEl.className.match(/language-(\S+)/);
      let lang = langMatch ? langMatch[1].toLowerCase() : null;
      const code = codeEl.textContent;

      try {
        if (lang && hljs.getLanguage(lang)) {
          codeEl.innerHTML = hljs.highlight(code, {
            language: lang
          }).value;
        } else {
          const auto = hljs.highlightAuto(code);
          codeEl.innerHTML = auto.value;
          lang = auto.language || "plaintext";
        }
      } catch {
        /* leave as plain escaped text */
      }

      codeEl.classList.add("hljs");

      const pre = codeEl.parentElement;
      const wrap = document.createElement("div");
      wrap.className = "code-block";

      const header = document.createElement("div");
      header.className = "code-block-header";

      const label = document.createElement("span");
      label.textContent = lang || "plaintext";

      const copyBtn = document.createElement("button");
      copyBtn.className = "code-block-copy";
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";

      copyBtn.addEventListener("click", () => {
        navigator.clipboard?.writeText(code).then(() => {
          copyBtn.textContent = "Copied";
          setTimeout(() => {
            copyBtn.textContent = "Copy";
          }, 1400);
        });
      });

      header.append(label, copyBtn);
      pre.parentNode.insertBefore(wrap, pre);
      wrap.append(header, pre);
    });
  }

  // ===================== Language / file helpers =====================
  function langForFilename(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return EXT_LANG[ext] || "plaintext";
  }

  function isTextExt(name) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    return TEXT_EXTENSIONS.has(ext);
  }

  function formatBytes(n) {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  // ===================== Theming =====================
  function applyTheme() {
    const t = state.settings.theme;
    app.dataset.theme = t;

    if (t === "custom") {
      const c = state.settings.customTheme;

      app.style.setProperty("--bg", c.bg);
      app.style.setProperty("--bg-elevated", c.bg);
      app.style.setProperty("--accent", c.accent);
      app.style.setProperty("--accent-hover", c.accent);
      app.style.setProperty("--pulse-1", hexToRgba(c.pulse, 0.08));
      app.style.setProperty("--pulse-2", hexToRgba(c.pulse, 0.05));
      app.dataset.pulses = c.pulsesEnabled ? "on" : "off";
    } else {
      [
        "--bg",
        "--bg-elevated",
        "--accent",
        "--accent-hover",
        "--pulse-1",
        "--pulse-2"
      ].forEach((p) => app.style.removeProperty(p));

      app.dataset.pulses = "on";
    }

    document.querySelectorAll(".theme-swatch").forEach((btn) => {
      btn.setAttribute(
        "aria-pressed",
        String(btn.dataset.themeChoice === t)
      );
    });

    el("customThemeControls").hidden = t !== "custom";
  }

  function hexToRgba(hex, a) {
    const h = hex.replace("#", "");
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);

    return `rgba(${r},${g},${b},${a})`;
  }

  // ===================== Rendering: screens & messages =====================
  function renderScreen() {
    const convo = getActiveConversation();
    const hasMessages = convo && convo.messages.length > 0;

    homeScreen.hidden = !!hasMessages;
    chatScreen.hidden = !hasMessages;

    if (hasMessages) renderMessages();

    updateComposerLockState();
  }

  function renderMessages() {
    const convo = getActiveConversation();
    messagesEl.innerHTML = "";

    if (!convo) return;

    convo.messages.forEach((m) => {
      messagesEl.appendChild(buildMessageEl(m));
    });

    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function buildMessageEl(m) {
    const row = document.createElement("div");
    row.className = `msg ${m.role}`;

    const bubble = document.createElement("div");
    bubble.className = "bubble";

    renderMarkdownInto(bubble, m.content);
    row.appendChild(bubble);

    if (m.attachments && m.attachments.length) {
      const wrap = document.createElement("div");
      wrap.className = "msg-attachments";

      m.attachments.forEach((a) => {
        const chip = document.createElement("span");
        chip.className = "msg-attachment-chip";
        chip.textContent = `${a.name} · ${formatBytes(a.size)}`;
        wrap.appendChild(chip);
      });

      bubble.appendChild(wrap);
    }

    return row;
  }

  // ===================== Activity panel =====================
  function createActivityPanel() {
    const panel = document.createElement("div");
    panel.className = "activity-panel expanded";

    const header = document.createElement("button");
    header.type = "button";
    header.className = "activity-header";
    header.innerHTML =
      `<span class="activity-spinner"></span>` +
      `<span class="chev">›</span>` +
      `<span class="activity-label">Thinking...</span>`;

    const steps = document.createElement("ul");
    steps.className = "activity-steps";

    header.addEventListener("click", () => {
      panel.classList.toggle("expanded");
    });

    panel.append(header, steps);

    const api = {
      el: panel,

      addStep(label) {
        const li = document.createElement("li");
        li.className = "current";
        li.textContent = label;
        steps.appendChild(li);
        return li;
      },

      completeStep(li) {
        if (li) li.classList.remove("current");
      },

      setCodePreview(li, lang, code) {
        let pre = li.querySelector(".code-preview");

        if (!pre) {
          pre = document.createElement("div");
          pre.className = "code-preview";
          pre.innerHTML = `<pre><code></code></pre>`;
          li.appendChild(pre);
        }

        const codeEl = pre.querySelector("code");
        codeEl.textContent = code;
        codeEl.className = `language-${lang || "plaintext"}`;
      },

      finish() {
        panel.classList.add("done");
        panel.classList.remove("expanded");
      },
    };

    return api;
  }

  // ===================== Stream control-token filter =====================
  function createStreamFilter() {
    let held = "";
    let fenceOpen = false;
    let ended = false;

    function toggleFences(text) {
      const matches = text.match(/```/g);

      if (matches) {
        for (let i = 0; i < matches.length; i++) {
          fenceOpen = !fenceOpen;
        }
      }
    }

    return {
      push(chunk) {
        if (ended) {
          return {
            visible: "",
            controlHit: false
          };
        }

        let combined = held + chunk;
        held = "";

        let visibleOut = "";
        let idx = 0;

        while (idx < combined.length) {
          const fenceIdx = combined.indexOf("```", idx);
          const tokenIdx =
            fenceOpen
              ? -1
              : combined.indexOf(CONTROL_TOKEN, idx);

          if (
            !fenceOpen &&
            tokenIdx !== -1 &&
            (fenceIdx === -1 || tokenIdx < fenceIdx)
          ) {
            visibleOut += combined.slice(idx, tokenIdx);
            ended = true;

            return {
              visible: visibleOut,
              controlHit: true
            };
          }

          if (fenceIdx !== -1) {
            visibleOut += combined.slice(idx, fenceIdx + 3);
            toggleFences(combined.slice(fenceIdx, fenceIdx + 3));
            idx = fenceIdx + 3;
          } else {
            visibleOut += combined.slice(idx);
            idx = combined.length;
          }
        }

        if (!fenceOpen) {
          for (
            let n = Math.min(
              CONTROL_TOKEN.length - 1,
              visibleOut.length
            );
            n > 0;
            n--
          ) {
            if (CONTROL_TOKEN.startsWith(visibleOut.slice(-n))) {
              held = visibleOut.slice(-n);
              visibleOut = visibleOut.slice(0, -n);
              break;
            }
          }
        }

        return {
          visible: visibleOut,
          controlHit: false
        };
      },

      flushRemainder() {
        const rest = held;
        held = "";
        return rest;
      },
    };
  }

  function checkBracketBalance(code) {
    const pairs = {
      "(": ")",
      "[": "]",
      "{": "}"
    };

    const closers = new Set(Object.values(pairs));
    const stack = [];

    for (const ch of code) {
      if (pairs[ch]) {
        stack.push(pairs[ch]);
      } else if (closers.has(ch)) {
        if (stack.pop() !== ch) return false;
      }
    }

    return stack.length === 0;
  }

  function analyzeStreamState(rawText) {
    const count = (rawText.match(/```/g) || []).length;

    if (count % 2 === 0) {
      return {
        writingFile: false
      };
    }

    const lastFence = rawText.lastIndexOf("```");
    const after = rawText.slice(lastFence + 3);
    const nl = after.indexOf("\n");
    const lang = nl === -1 ? after.trim() : after.slice(0, nl).trim();
    const code = nl === -1 ? "" : after.slice(nl + 1);

    return {
      writingFile: true,
      lang,
      code
    };
  }

  // ===================== Token usage =====================
  function addEstimatedTokens(text) {
    ensureTodayUsage();
    state.tokenUsage.estimated += Math.ceil((text || "").length / 4);
    saveState();
    renderUsage();
  }

  function addExactUsage(totalTokens) {
    ensureTodayUsage();
    state.tokenUsage.exact += totalTokens || 0;
    state.tokenUsage.hasExact = true;
    saveState();
    renderUsage();
  }

  function ensureTodayUsage() {
    if (state.tokenUsage.date !== todayKey()) {
      state.tokenUsage = {
        date: todayKey(),
        estimated: 0,
        exact: 0,
        hasExact: false
      };
    }
  }

  function renderUsage() {
    ensureTodayUsage();

    const shown = state.tokenUsage.hasExact
      ? state.tokenUsage.exact
      : state.tokenUsage.estimated;

    const label = state.tokenUsage.hasExact
      ? `${shown.toLocaleString()} tokens today`
      : `~${shown.toLocaleString()} estimated tokens today`;

    const fillPct = Math.min(
      100,
      (shown / VISUAL_DAILY_TOKEN_REFERENCE) * 100
    );

    const usageBarFill = el("usageBarFill");
    const usageLabel = el("usageLabel");

    if (usageBarFill) {
      usageBarFill.style.width = `${fillPct}%`;
    }

    if (usageLabel) {
      usageLabel.textContent = label;
    }

    devTokens.textContent = `Today: ${label}`;
  }

  // ===================== Composer =====================
  function updateSendState() {
    const hasText = composerInput.value.trim().length > 0;
    const hasFiles = pendingAttachments.length > 0;
    const active = hasText || hasFiles;

    sendBtn.disabled = !active;
    sendBtn.classList.toggle("active", active);
  }

  composerInput.addEventListener("input", () => {
    composerInput.style.height = "auto";
    composerInput.style.height =
      Math.min(160, composerInput.scrollHeight) + "px";

    updateSendState();
  });

  composerInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      composerForm.requestSubmit();
    }
  });

  attachBtn.addEventListener("click", () => fileInput.click());

  fileInput.addEventListener("change", () => {
    handleFiles(Array.from(fileInput.files || []));
    fileInput.value = "";
  });

  function handleFiles(files) {
    fileErrorEl.hidden = true;

    for (const file of files) {
      if (
        file.type.startsWith("image/") ||
        file.type.startsWith("video/")
      ) {
        fileErrorEl.textContent = "Images and videos aren't supported.";
        fileErrorEl.hidden = false;
        continue;
      }

      const att = {
        id: uid(),
        name: file.name,
        size: file.size,
        ext: (file.name.split(".").pop() || "").toLowerCase(),
        content: null,
        binary: true
      };

      if (
        isTextExt(file.name) &&
        file.size <= MAX_READABLE_BYTES
      ) {
        const reader = new FileReader();

        reader.onload = () => {
          att.content = reader.result;
          att.binary = false;
          renderFileChips();
        };

        reader.onerror = () => renderFileChips();
        reader.readAsText(file);
      }

      pendingAttachments.push(att);
    }

    renderFileChips();
    updateSendState();
  }

  function renderFileChips() {
    fileChipsEl.innerHTML = "";
    fileChipsEl.hidden = pendingAttachments.length === 0;

    pendingAttachments.forEach((a) => {
      const chip = document.createElement("div");
      chip.className = "file-chip";

      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${a.name} · ${formatBytes(a.size)}`;

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "remove";
      remove.setAttribute("aria-label", `Remove ${a.name}`);
      remove.textContent = "✕";

      remove.addEventListener("click", () => {
        pendingAttachments =
          pendingAttachments.filter((x) => x.id !== a.id);

        renderFileChips();
        updateSendState();
      });

      chip.append(name, remove);
      fileChipsEl.appendChild(chip);
    });
  }

  function updateComposerLockState() {
    const convo = getActiveConversation();
    const ended = !!(convo && convo.ended);

    composerInput.disabled = ended;
    attachBtn.disabled = ended;
    sendBtn.disabled = ended || sendBtn.disabled;
    endedBanner.hidden = !ended;
  }

  // ===================== Conversations =====================
  function ensureActiveConversation() {
    if (getActiveConversation()) return;

    const convo = {
      id: uid(),
      title: "New conversation",
      messages: [],
      ended: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    state.conversations.unshift(convo);
    activeConversationId = convo.id;
  }

  function createNewChat() {
    const convo = {
      id: uid(),
      title: "New conversation",
      messages: [],
      ended: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    state.conversations.unshift(convo);
    activeConversationId = convo.id;

    saveState();
    renderScreen();
    renderConversationList();

    if (!state.settings.keepSidebarOpen) {
      closeSidebar();
    }
  }

  function switchConversation(id) {
    activeConversationId = id;

    renderScreen();
    renderConversationList();

    if (!state.settings.keepSidebarOpen) {
      closeSidebar();
    }
  }

  function renderConversationList() {
    conversationListEl.innerHTML = "";

    state.conversations
      .slice()
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .forEach((c) => {
        const item = document.createElement("div");

        item.className =
          "conversation-item" +
          (c.id === activeConversationId ? " active" : "");

        item.setAttribute("role", "listitem");

        const btn = document.createElement("button");
        btn.className = "convo-btn";
        btn.textContent = c.title;
        btn.addEventListener("click", () => switchConversation(c.id));

        const trash = document.createElement("button");
        trash.className = "icon-btn trash-btn";
        trash.setAttribute("aria-label", `Delete ${c.title}`);

        trash.innerHTML =
          `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true">` +
          `<path d="M4 7h16M9 7V5a1 1 0 011-1h4a1 1 0 011 1v2m-8 0l1 13a1 1 0 001 1h6a1 1 0 001-1l1-13"` +
          ` stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>` +
          `</svg>`;

        trash.addEventListener("click", (e) => {
          e.stopPropagation();
          pendingDeleteId = c.id;
          openModal(deleteModal);
        });

        item.append(btn, trash);
        conversationListEl.appendChild(item);
      });
  }

  function deleteConversation(id) {
    state.conversations =
      state.conversations.filter((c) => c.id !== id);

    if (activeConversationId === id) {
      activeConversationId =
        state.conversations[0]?.id || null;
    }

    saveState();
    renderScreen();
    renderConversationList();
  }

  async function maybeGenerateTitle(convo) {
    if (convo.messages.length !== 2) return;

    try {
      const res = await fetch(`${WORKER_URL}/api/summarize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: convo.messages.map((m) => ({
            role: m.role,
            content: m.content
          }))
        }),
      });

      if (!res.ok) throw new Error("bad status");

      const data = await res.json();

      if (data.title) {
        convo.title = data.title;
        saveState();
        renderConversationList();
      }
    } catch {
      convo.title =
        convo.messages[0].content.slice(0, 40) ||
        "New conversation";

      saveState();
      renderConversationList();
    }
  }

  // ===================== Sending / streaming =====================
  function buildApiMessages(convo) {
    let sys = SYSTEM_PROMPT;

    if (
      state.settings.memoryEnabled &&
      state.settings.memoryPreferences.trim()
    ) {
      sys +=
        `\n\nThe user has shared these standing preferences about themselves:\n` +
        `${state.settings.memoryPreferences.trim()}`;
    }

    if (
      state.settings.memoryEnabled &&
      state.settings.memorySummary.trim()
    ) {
      sys +=
        `\n\nSummary of earlier context with this user:\n` +
        `${state.settings.memorySummary.trim()}`;
    }

    return [
      {
        role: "system",
        content: sys
      },
      ...convo.messages.map((m) => ({
        role: m.role,
        content: m.content
      }))
    ];
  }

  function composeUserContent(text, attachments) {
    let content = text || "";

    attachments.forEach((a) => {
      if (a.binary || a.content == null) {
        content +=
          `\n\n[Attached file: ${a.name} (${formatBytes(a.size)}) — ` +
          `binary or unread, contents not included]`;
      } else {
        content +=
          `\n\n[Attached file: ${a.name}]\n` +
          "```" +
          `${langForFilename(a.name)}\n` +
          `${a.content}\n` +
          "```";
      }
    });

    return content;
  }

  composerForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const text = composerInput.value.trim();
    const attachments = pendingAttachments;

    if (!text && attachments.length === 0) return;

    const convo0 = getActiveConversation();

    if (convo0 && convo0.ended) return;

    composerInput.value = "";
    composerInput.style.height = "auto";
    pendingAttachments = [];

    renderFileChips();
    updateSendState();

    if (text === CONTROL_TOKEN) {
      handleUserSentControlToken(text, attachments);
      return;
    }

    await sendMessage(text, attachments);
  });

  function handleUserSentControlToken(text, attachments) {
    ensureActiveConversation();

    const convo = getActiveConversation();

    convo.messages.push({
      id: uid(),
      role: "user",
      content: composeUserContent(text, attachments),
      attachments: attachments.map(stripContent)
    });

    convo.messages.push({
      id: uid(),
      role: "assistant",
      content: "Got it — ending this conversation."
    });

    convo.ended = true;
    convo.updatedAt = Date.now();

    saveState();
    renderScreen();
    renderConversationList();
  }

  function stripContent(a) {
    return {
      name: a.name,
      size: a.size,
      ext: a.ext
    };
  }

  async function sendMessage(text, attachments) {
    ensureActiveConversation();

    const convo = getActiveConversation();

    const userContent =
      composeUserContent(text, attachments);

    convo.messages.push({
      id: uid(),
      role: "user",
      content: userContent,
      attachments: attachments.map(stripContent)
    });

    convo.updatedAt = Date.now();

    homeScreen.hidden = true;
    chatScreen.hidden = false;

    renderMessages();
    saveState();
    addEstimatedTokens(userContent);

    const assistantMsg = {
      id: uid(),
      role: "assistant",
      content: ""
    };

    convo.messages.push(assistantMsg);

    const assistantRow = buildMessageEl(assistantMsg);
    const bubble = assistantRow.querySelector(".bubble");

    const activity = createActivityPanel();

    messagesEl.appendChild(activity.el);
    messagesEl.appendChild(assistantRow);
    messagesEl.scrollTop = messagesEl.scrollHeight;

    let step = activity.addStep("Examining user prompt");
    activity.completeStep(step);

    if (attachments.length) {
      step = activity.addStep("Reading attached file");
      activity.completeStep(step);
    }

    if (
      attachments.some((a) => isTextExt(a.name)) ||
      /```/.test(text)
    ) {
      step = activity.addStep("Analyzing code");
      activity.completeStep(step);
    }

    const filter = createStreamFilter();

    let raw = "";
    let visible = "";
    let genStep = null;
    let writingStep = null;
    let controlHit = false;

    try {
      const res = await fetch(`${WORKER_URL}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          messages: buildApiMessages(convo).slice(0, -1),
          model: MODEL_ID,
          customKey: state.settings.apiKey || undefined,
          conversationId: convo.id,
        }),
      });

      if (res.headers.get("X-Astral-Fallback") === "true") {
        showToast(
          "Custom API key failed — used the default key instead."
        );
      }

      if (!res.ok || !res.body) {
        let msg =
          "Something went wrong reaching Astral's backend.";

        try {
          const errData = await res.json();
          if (errData.error) msg = errData.error;
        } catch {}

        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const {
          done,
          value
        } = await reader.read();

        if (done) break;

        buffer += decoder.decode(value, {
          stream: true
        });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data:")) continue;

          const data = line.slice(5).trim();

          if (!data || data === "[DONE]") continue;

          let json;

          try {
            json = JSON.parse(data);
          } catch {
            continue;
          }

          if (json.usage?.total_tokens) {
            addExactUsage(json.usage.total_tokens);
          }

          const delta =
            json.choices?.[0]?.delta?.content;

          if (!delta) continue;

          raw += delta;

          const result = filter.push(delta);

          visible += result.visible;
          assistantMsg.content = visible;

          renderMarkdownInto(
            bubble,
            visible
          );

          messagesEl.scrollTop =
            messagesEl.scrollHeight;

          const streamState =
            analyzeStreamState(raw);

          if (streamState.writingFile) {
            if (genStep) {
              activity.completeStep(genStep);
              genStep = null;
            }

            if (!writingStep) {
              writingStep =
                activity.addStep("Writing File");
            }

            activity.setCodePreview(
              writingStep,
              streamState.lang,
              streamState.code
            );
          } else {
            if (writingStep) {
              activity.completeStep(writingStep);

              const codeMatch =
                raw.match(/```[^\n]*\n([\s\S]*?)```/g);

              if (codeMatch) {
                const lastBlock =
                  codeMatch[codeMatch.length - 1];

                const inner =
                  lastBlock
                    .replace(/```[^\n]*\n/, "")
                    .replace(/```$/, "");

                const syn =
                  activity.addStep("Checking syntax");

                activity.completeStep(syn);

                if (!checkBracketBalance(inner)) {
                  const li = activity.addStep(
                    "Note: unbalanced brackets detected in that block"
                  );

                  activity.completeStep(li);
                }
              }

              writingStep = null;
            }

            if (!genStep) {
              genStep =
                activity.addStep("Generating response");
            }
          }

          if (result.controlHit) {
            controlHit = true;
            reader.cancel().catch(() => {});
            break;
          }
        }

        if (controlHit) break;
      }

      if (!controlHit) {
        visible += filter.flushRemainder();
      }

      assistantMsg.content =
        visible.trim() || "(no response)";

      renderMarkdownInto(
        bubble,
        assistantMsg.content
      );

      addEstimatedTokens(
        assistantMsg.content
      );

      if (genStep) {
        activity.completeStep(genStep);
      }

      const fmt =
        activity.addStep("Formatting response");

      activity.completeStep(fmt);
      activity.finish();

      if (controlHit) {
        convo.ended = true;
        updateComposerLockState();
      }

      convo.updatedAt = Date.now();

      saveState();
      renderConversationList();
      maybeGenerateTitle(convo);

    } catch (err) {
      activity.finish();

      assistantMsg.content =
        (assistantMsg.content
          ? assistantMsg.content + "\n\n"
          : "") +
        `_Something interrupted this response: ` +
        `${escapePlain(err.message || "network error")}. ` +
        `Your partial response above was kept — ` +
        `you can try sending again._`;

      renderMarkdownInto(
        bubble,
        assistantMsg.content
      );

      saveState();
    }
  }

  function escapePlain(s) {
    return String(s).replace(/[<>]/g, "");
  }

  // ===================== Sidebar =====================
  function openSidebar() {
    sidebarOpen = true;

    sidebar.classList.add("open");
    sidebar.setAttribute("aria-hidden", "false");

    sidebarOverlay.hidden = false;

    requestAnimationFrame(() =>
      sidebarOverlay.classList.add("show")
    );

    sidebarToggle.setAttribute(
      "aria-expanded",
      "true"
    );
  }

  function closeSidebar() {
    sidebarOpen = false;

    sidebar.classList.remove("open");
    sidebar.setAttribute("aria-hidden", "true");

    sidebarOverlay.classList.remove("show");

    setTimeout(
      () => (sidebarOverlay.hidden = true),
      200
    );

    sidebarToggle.setAttribute(
      "aria-expanded",
      "false"
    );
  }

  sidebarToggle.addEventListener(
    "click",
    () => (
      sidebarOpen
        ? closeSidebar()
        : openSidebar()
    )
  );

  sidebarOverlay.addEventListener(
    "click",
    closeSidebar
  );

  newChatBtn.addEventListener(
    "click",
    createNewChat
  );

  endedNewChat.addEventListener(
    "click",
    createNewChat
  );

  // ===================== Modals =====================
  function openModal(modal) {
    modal.hidden = false;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
  }

  function closeModal(modal) {
    modal.hidden = true;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  document.querySelectorAll("[data-close]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.close;

      if (key === "settings") {
        closeModal(settingsModal);
      }

      if (key === "delete") {
        closeModal(deleteModal);
      }

      if (key === "confirm") {
        closeModal(confirmModal);
      }
    });
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;

    if (!settingsModal.hidden) {
      closeModal(settingsModal);
    } else if (!deleteModal.hidden) {
      closeModal(deleteModal);
    } else if (!confirmModal.hidden) {
      closeModal(confirmModal);
    } else if (sidebarOpen) {
      closeSidebar();
    }
  });

  el("deleteCancel").addEventListener(
    "click",
    () => closeModal(deleteModal)
  );

  el("deleteConfirmBtn").addEventListener(
    "click",
    () => {
      if (pendingDeleteId) {
        deleteConversation(pendingDeleteId);
      }

      pendingDeleteId = null;
      closeModal(deleteModal);
    }
  );

  function confirmAction(title, body, onConfirm) {
    el("confirmTitle").textContent = title;
    el("confirmBody").textContent = body;
    confirmHandler = onConfirm;
    openModal(confirmModal);
  }

  el("confirmCancel").addEventListener(
    "click",
    () => {
      confirmHandler = null;
      closeModal(confirmModal);
    }
  );

  el("confirmOk").addEventListener(
    "click",
    () => {
      if (confirmHandler) {
        confirmHandler();
      }

      confirmHandler = null;
      closeModal(confirmModal);
    }
  );

  // ===================== Settings =====================
  settingsBtn.addEventListener(
    "click",
    () => {
      populateSettingsUI();
      openModal(settingsModal);
    }
  );

  el("settingsSave").addEventListener(
    "click",
    () => closeModal(settingsModal)
  );

  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tab-btn").forEach((b) => {
        b.classList.remove("active");
        b.setAttribute("aria-selected", "false");
      });

      document.querySelectorAll(".settings-panel").forEach((p) => {
        p.classList.remove("active");
      });

      btn.classList.add("active");

      btn.setAttribute(
        "aria-selected",
        "true"
      );

      document
        .querySelector(
          `.settings-panel[data-panel="${btn.dataset.tab}"]`
        )
        .classList.add("active");
    });
  });

  el("keepSidebarOpen").addEventListener(
    "change",
    (e) => {
      state.settings.keepSidebarOpen =
        e.target.checked;

      saveState();
    }
  );

  document.querySelectorAll(".theme-swatch").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.settings.theme =
        btn.dataset.themeChoice;

      applyTheme();
      saveState();
    });
  });

  [
    "customBg",
    "customAccent",
    "customSwitch",
    "customPulse"
  ].forEach((id) => {
    el(id).addEventListener("input", (e) => {
      const key = {
        customBg: "bg",
        customAccent: "accent",
        customSwitch: "switchColor",
        customPulse: "pulse"
      }[id];

      state.settings.customTheme[key] =
        e.target.value;

      if (state.settings.theme === "custom") {
        applyTheme();
      }

      saveState();
    });
  });

  el("pulsesToggle").addEventListener(
    "change",
    (e) => {
      state.settings.customTheme.pulsesEnabled =
        e.target.checked;

      if (state.settings.theme === "custom") {
        applyTheme();
      }

      saveState();
    }
  );

  el("apiKeyInput").addEventListener(
    "change",
    (e) => {
      state.settings.apiKey =
        e.target.value.trim();

      saveState();

      const status =
        el("apiKeyStatus");

      status.hidden = false;

      status.textContent =
        state.settings.apiKey
          ? "Custom key saved locally in this browser."
          : "Using the default Astral key.";
    }
  );

  el("memoryToggle").addEventListener(
    "change",
    (e) => {
      state.settings.memoryEnabled =
        e.target.checked;

      saveState();
    }
  );

  el("memoryPrefs").addEventListener(
    "change",
    (e) => {
      state.settings.memoryPreferences =
        e.target.value;

      saveState();
    }
  );

  el("clearMemorySummary").addEventListener(
    "click",
    () => {
      confirmAction(
        "Clear memory summary?",
        "This removes what Astral has learned from past conversations.",
        () => {
          state.settings.memorySummary = "";
          saveState();
          populateSettingsUI();
        }
      );
    }
  );

  el("devModeToggle").addEventListener(
    "change",
    (e) => {
      state.settings.developerMode =
        e.target.checked;

      el("devControls").hidden =
        !e.target.checked;

      devInfo.hidden =
        !e.target.checked;

      saveState();
    }
  );

  el("devDeleteAll").addEventListener(
    "click",
    () => {
      confirmAction(
        "Delete all conversation data?",
        "This permanently deletes every conversation.",
        () => {
          state.conversations = [];
          activeConversationId = null;

          saveState();
          renderScreen();
          renderConversationList();
        }
      );
    }
  );

  el("devClearMemory").addEventListener(
    "click",
    () => el("clearMemorySummary").click()
  );

  el("devImport").addEventListener(
    "click",
    () => el("devImportInput").click()
  );

  el("devImportInput").addEventListener(
    "change",
    async (e) => {
      const file = e.target.files[0];
      e.target.value = "";

      if (!file) return;

      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const list = Array.isArray(data)
          ? data
          : [data];

        list.forEach((c) => {
          if (!c || !Array.isArray(c.messages)) {
            return;
          }

          state.conversations.unshift({
            id: uid(),
            title:
              c.title ||
              "Imported conversation",
            messages: c.messages.map((m) => ({
              id: uid(),
              role:
                m.role === "assistant"
                  ? "assistant"
                  : "user",
              content:
                String(m.content || "")
            })),
            ended: false,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        });

        saveState();
        renderConversationList();
        showToast("Conversation imported.");

      } catch {
        showToast(
          "That file couldn't be imported — expected JSON with a messages array."
        );
      }
    }
  );

  function populateSettingsUI() {
    el("keepSidebarOpen").checked =
      state.settings.keepSidebarOpen;

    el("customBg").value =
      state.settings.customTheme.bg;

    el("customAccent").value =
      state.settings.customTheme.accent;

    el("customSwitch").value =
      state.settings.customTheme.switchColor;

    el("customPulse").value =
      state.settings.customTheme.pulse;

    el("pulsesToggle").checked =
      state.settings.customTheme.pulsesEnabled;

    el("apiKeyInput").value =
      state.settings.apiKey;

    el("memoryToggle").checked =
      state.settings.memoryEnabled;

    el("memoryPrefs").value =
      state.settings.memoryPreferences;

    el("memorySummary").textContent =
      state.settings.memorySummary ||
      "Nothing learned yet.";

    el("devModeToggle").checked =
      state.settings.developerMode;

    el("devControls").hidden =
      !state.settings.developerMode;

    devInfo.hidden =
      !state.settings.developerMode;

    applyTheme();
    renderUsage();
  }

  // ===================== Toast =====================
  let toastTimer = null;

  function showToast(msg) {
    toastEl.textContent = msg;
    toastEl.hidden = false;

    clearTimeout(toastTimer);

    toastTimer = setTimeout(
      () => (toastEl.hidden = true),
      3600
    );
  }

  // ===================== Init =====================
  function init() {
    // Force all modals closed on startup.
    // This also overrides the CSS .modal { display: flex; }
    // rule that was making them appear immediately.
    [settingsModal, deleteModal, confirmModal].forEach((modal) => {
      closeModal(modal);
    });

    applyTheme();

    if (sidebarOpen) {
      openSidebar();
    }

    renderConversationList();
    renderScreen();
    renderUsage();

    devInfo.hidden =
      !state.settings.developerMode;

    updateSendState();
  }

  init();
})();
