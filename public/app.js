(() => {
  const indexForm = document.getElementById("index-form");
  const repoInput = document.getElementById("repo-input");
  const indexBtn = document.getElementById("index-btn");
  const indexStatus = document.getElementById("index-status");

  const askPanel = document.getElementById("ask-panel");
  const askForm = document.getElementById("ask-form");
  const questionInput = document.getElementById("question-input");
  const askBtn = document.getElementById("ask-btn");
  const askStatus = document.getElementById("ask-status");
  const indexedRepoLabel = document.getElementById("indexed-repo-label");

  const answerCard = document.getElementById("answer-card");
  const answerMode = document.getElementById("answer-mode");
  const answerText = document.getElementById("answer-text");
  const citationsList = document.getElementById("citations-list");

  let current = null; // { owner, repo }

  function parseRepoInput(raw) {
    const s = raw.trim().replace(/\.git$/, "");
    const short = s.match(/^([\w.-]+)\/([\w.-]+)$/);
    if (short) return { owner: short[1], repo: short[2] };
    try {
      const url = new URL(s);
      if (url.hostname !== "github.com") return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2) return null;
      return { owner: parts[0], repo: parts[1] };
    } catch {
      return null;
    }
  }

  function setStatus(el, text, kind) {
    el.className = "status" + (kind ? " " + kind : "");
    el.innerHTML = text;
  }

  indexForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const parsed = parseRepoInput(repoInput.value);
    if (!parsed) {
      setStatus(indexStatus, "Enter a repo as owner/repo or a github.com URL.", "error");
      return;
    }
    indexBtn.disabled = true;
    askPanel.hidden = true;
    answerCard.hidden = true;
    setStatus(indexStatus, '<span class="spinner"></span>Fetching and indexing files from GitHub…', "");
    try {
      const res = await fetch("/api/index-repo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(parsed),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      current = { owner: data.owner, repo: data.repo };
      setStatus(
        indexStatus,
        `Indexed <strong>${data.owner}/${data.repo}</strong>@${data.branch}: ` +
          `${data.fileCount} files → ${data.chunkCount} chunks.` +
          (data.truncated ? " (GitHub truncated the file tree; large repo, partial index.)" : ""),
        "success",
      );
      indexedRepoLabel.textContent = `${data.owner}/${data.repo}`;
      askPanel.hidden = false;
      questionInput.focus();
    } catch (err) {
      setStatus(indexStatus, String(err.message || err), "error");
    } finally {
      indexBtn.disabled = false;
    }
  });

  askForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!current) return;
    const question = questionInput.value.trim();
    if (!question) return;
    askBtn.disabled = true;
    answerCard.hidden = true;
    setStatus(askStatus, '<span class="spinner"></span>Retrieving relevant chunks and composing an answer…', "");
    try {
      const res = await fetch("/api/ask-repo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner: current.owner, repo: current.repo, question }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      setStatus(askStatus, "Done.", "success");
      answerMode.textContent =
        data.answerMode === "llm" ? `LLM-synthesized answer (${data.model})` : "Deterministic citation answer (no LLM key configured)";
      answerText.textContent = data.answer;
      citationsList.innerHTML = "";
      for (const c of data.citations) {
        const li = document.createElement("li");
        const pathSpan = document.createElement("span");
        pathSpan.className = "cite-path";
        pathSpan.textContent = `[${c.rank}] ${c.path} (lines ${c.startLine}-${c.endLine}) — score ${c.score}`;
        const excerpt = document.createElement("span");
        excerpt.className = "cite-excerpt";
        excerpt.textContent = c.excerpt;
        li.appendChild(pathSpan);
        li.appendChild(excerpt);
        citationsList.appendChild(li);
      }
      answerCard.hidden = false;
    } catch (err) {
      setStatus(askStatus, String(err.message || err), "error");
    } finally {
      askBtn.disabled = false;
    }
  });
})();
