/**
 * 本文取り込みエディタ
 * - PDF / TXT をローカルで読み込み
 * - Quill によるリッチテキスト編集（太字・斜体・色・コードブロックなど）
 * - すべて localStorage のみ（サーバー送信なし）
 * - PC / iPad 対応
 */

(function () {
  'use strict';

  // ===== PDF.js ワーカー設定 =====
  if (typeof pdfjsLib !== 'undefined') {
    pdfjsLib.GlobalWorkerOptions.workerSrc =
      'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
  }

  // ===== 状態 =====
  let quill = null;
  let todos = [];
  let autoSaveTimer = null;
  let isDirty = false;
  const STORAGE_KEY = 'text-importer-editor-data';
  const TODO_KEY = 'text-importer-editor-todos';
  const SETTINGS_KEY = 'text-importer-editor-settings';

  // ===== DOM 参照 =====
  const $ = (sel) => document.querySelector(sel);
  const fileInput = $('#file-input');
  const btnLoad = $('#btn-load-file');
  const fileNameEl = $('#file-name');
  const loadingOverlay = $('#loading-overlay');
  const loadingText = $('#loading-text');
  const toastEl = $('#toast');
  const overviewEl = $('#overview');
  const assumptionsEl = $('#assumptions');
  const todoInput = $('#todo-input');
  const todoListEl = $('#todo-list');
  const charCountEl = $('#char-count');
  const saveStatusEl = $('#save-status');
  const leftPanel = $('#left-panel');
  const rightPanel = $('#right-panel');

  // ===== ユーティリティ =====
  function showToast(message, type = 'success', duration = 2800) {
    toastEl.textContent = message;
    toastEl.className = `toast ${type}`;
    setTimeout(() => toastEl.classList.add('hidden'), duration);
  }

  function showLoading(text = 'ファイルを読み込み中...') {
    loadingText.textContent = text;
    loadingOverlay.classList.remove('hidden');
  }

  function hideLoading() {
    loadingOverlay.classList.add('hidden');
  }

  function updateCharCount() {
    if (!quill) return;
    const text = quill.getText().trim();
    charCountEl.textContent = `${text.length.toLocaleString()} 文字`;
  }

  function markDirty() {
    isDirty = true;
    saveStatusEl.textContent = '未保存';
    saveStatusEl.style.color = '#dc2626';
  }

  function markSaved() {
    isDirty = false;
    saveStatusEl.textContent = '保存済み';
    saveStatusEl.style.color = '#059669';
  }

  // ===== Quill 初期化 =====
  function initQuill() {
    const toolbarOptions = [
      [{ header: [1, 2, 3, false] }],
      ['bold', 'italic', 'underline', 'strike'],
      [{ color: [] }, { background: [] }],
      [{ list: 'ordered' }, { list: 'bullet' }],
      [{ indent: '-1' }, { indent: '+1' }],
      ['blockquote', 'code-block'],
      ['link'],
      ['clean']
    ];

    quill = new Quill('#editor', {
      theme: 'snow',
      modules: {
        toolbar: {
          container: toolbarOptions,
          handlers: {
            // 必要に応じてカスタムハンドラ追加可能
          }
        },
        clipboard: {
          matchVisual: false
        }
      },
      placeholder: 'ここに本文を入力するか、左上の「本文から取り込み」からPDF/TXTを読み込んでください...\n\n見出しを使うと左側の目次に自動反映されます。'
    });

    // 変更検知
    quill.on('text-change', () => {
      markDirty();
      updateCharCount();
      // 目次は少し遅延させて更新（パフォーマンス）
      clearTimeout(window._tocTimer);
      window._tocTimer = setTimeout(updateTOC, 400);
    });

    // 初期フォーカス
    quill.focus();
  }

  // ===== 目次生成 =====
  function updateTOC() {
    if (!quill) return;
    const toc = $('#toc');
    const deltas = quill.getContents();
    const items = [];
    let currentIndex = 0;

    deltas.ops.forEach((op) => {
      if (typeof op.insert === 'string') {
        const lines = op.insert.split('\n');
        // 簡易的にヘッダーを検出（Quillのheader属性付き）
      }
    });

    // より確実な方法: DOMから見出しを取得
    const editorEl = quill.root;
    const headings = editorEl.querySelectorAll('h1, h2, h3');
    toc.innerHTML = '';

    if (headings.length === 0) {
      toc.innerHTML = '<p class="toc-empty">見出し（H1〜H3）を追加するとここに表示されます</p>';
      return;
    }

    headings.forEach((h, i) => {
      const level = parseInt(h.tagName.substring(1), 10);
      const text = h.textContent.trim() || `(見出し ${i + 1})`;
      const a = document.createElement('a');
      a.className = `toc-item level-${level}`;
      a.textContent = text;
      a.href = '#';
      a.addEventListener('click', (e) => {
        e.preventDefault();
        h.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // アクティブ表示
        document.querySelectorAll('.toc-item').forEach(el => el.classList.remove('active'));
        a.classList.add('active');
      });
      toc.appendChild(a);
    });
  }

  // ===== ファイル読み込み =====
  btnLoad.addEventListener('click', () => fileInput.click());

  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const ext = file.name.split('.').pop().toLowerCase();
    fileNameEl.textContent = file.name;

    showLoading(`${file.name} を解析中...`);

    try {
      let text = '';
      if (ext === 'txt' || file.type === 'text/plain') {
        text = await readTextFile(file);
      } else if (ext === 'pdf' || file.type === 'application/pdf') {
        text = await extractPdfText(file);
      } else {
        throw new Error('対応していないファイル形式です。.txt または .pdf を選択してください。');
      }

      // エディタにセット（プレーンテキストとして挿入）
      // 改行を保持しつつ、余分な空白を整える
      const cleaned = text
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      quill.setText(cleaned);
      quill.setSelection(0, 0);
      updateCharCount();
      updateTOC();
      markDirty();
      showToast(`「${file.name}」を取り込みました`, 'success');
    } catch (err) {
      console.error(err);
      showToast(err.message || '読み込みに失敗しました', 'error', 4000);
    } finally {
      hideLoading();
      // 同じファイルを再選択できるようにリセット
      fileInput.value = '';
    }
  });

  function readTextFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('テキストファイルの読み込みに失敗しました'));
      // 文字コード自動判定はブラウザ依存。UTF-8前提。Shift_JIS等は別途対応が必要
      reader.readAsText(file, 'UTF-8');
    });
  }

  async function extractPdfText(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF.js が読み込まれていません。ネットワークを確認してください。');
    }

    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const numPages = pdf.numPages;
    let fullText = '';

    for (let i = 1; i <= numPages; i++) {
      loadingText.textContent = `PDF を解析中... (${i}/${numPages} ページ)`;
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // アイテムを結合。位置情報からある程度改行を推定
      let lastY = null;
      let pageText = '';
      content.items.forEach((item) => {
        if (lastY !== null && Math.abs(item.transform[5] - lastY) > 8) {
          pageText += '\n';
        }
        pageText += item.str;
        lastY = item.transform[5];
      });
      fullText += pageText + '\n\n';
    }

    if (!fullText.trim()) {
      throw new Error('このPDFから文字を抽出できませんでした（スキャン画像の可能性があります）。OCR対応版が必要です。');
    }
    return fullText;
  }

  // ===== 保存 / 読み込み (localStorage) =====
  function saveAll() {
    if (!quill) return;
    const data = {
      content: quill.getContents(),
      html: quill.root.innerHTML,
      overview: overviewEl.value,
      assumptions: assumptionsEl.value,
      todos: todos,
      savedAt: new Date().toISOString()
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      markSaved();
      showToast('ローカルに保存しました', 'success');
    } catch (e) {
      showToast('保存に失敗しました（容量不足の可能性）', 'error');
    }
  }

  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      if (data.content) {
        quill.setContents(data.content);
      } else if (data.html) {
        quill.root.innerHTML = data.html;
      }
      if (data.overview) overviewEl.value = data.overview;
      if (data.assumptions) assumptionsEl.value = data.assumptions;
      if (Array.isArray(data.todos)) {
        todos = data.todos;
        renderTodos();
      }
      updateCharCount();
      updateTOC();
      markSaved();
    } catch (e) {
      console.warn('保存データの読み込みに失敗', e);
    }
  }

  // ===== TODO =====
  function renderTodos() {
    todoListEl.innerHTML = '';
    todos.forEach((t, idx) => {
      const li = document.createElement('li');
      li.className = `todo-item ${t.done ? 'done' : ''}`;
      li.innerHTML = `
        <input type="checkbox" ${t.done ? 'checked' : ''} data-idx="${idx}" />
        <span>${escapeHtml(t.text)}</span>
        <button class="todo-delete" data-idx="${idx}" title="削除">×</button>
      `;
      todoListEl.appendChild(li);
    });
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  $('#btn-add-todo').addEventListener('click', addTodo);
  todoInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') addTodo();
  });

  function addTodo() {
    const text = todoInput.value.trim();
    if (!text) return;
    todos.push({ text, done: false });
    todoInput.value = '';
    renderTodos();
    markDirty();
    saveTodosOnly();
  }

  todoListEl.addEventListener('click', (e) => {
    const idx = e.target.dataset.idx;
    if (idx === undefined) return;
    if (e.target.type === 'checkbox') {
      todos[idx].done = e.target.checked;
      renderTodos();
      markDirty();
      saveTodosOnly();
    } else if (e.target.classList.contains('todo-delete')) {
      todos.splice(idx, 1);
      renderTodos();
      markDirty();
      saveTodosOnly();
    }
  });

  function saveTodosOnly() {
    localStorage.setItem(TODO_KEY, JSON.stringify(todos));
  }

  // ===== エクスポート =====
  $('#btn-export-html').addEventListener('click', () => {
    const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <title>エクスポート本文</title>
  <style>
    body { font-family: sans-serif; line-height: 1.7; max-width: 800px; margin: 40px auto; padding: 0 20px; }
    pre { background: #23241f; color: #f8f8f2; padding: 12px 16px; border-radius: 6px; overflow-x: auto; }
    h1,h2,h3 { margin-top: 1.4em; }
  </style>
</head>
<body>
${quill.root.innerHTML}
</body>
</html>`;
    downloadBlob(html, 'text-export.html', 'text/html');
  });

  $('#btn-export-txt').addEventListener('click', () => {
    const text = quill.getText();
    downloadBlob(text, 'text-export.txt', 'text/plain');
  });

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
    showToast(`${filename} をダウンロードしました`);
  }

  // ===== クリア =====
  $('#btn-clear').addEventListener('click', () => {
    if (!confirm('編集中の内容をすべてクリアしますか？\n（ローカル保存データは残ります）')) return;
    quill.setText('');
    overviewEl.value = '';
    assumptionsEl.value = '';
    updateCharCount();
    updateTOC();
    markDirty();
    showToast('クリアしました');
  });

  // ===== パネル切替 =====
  $('#btn-toggle-left').addEventListener('click', () => {
    leftPanel.classList.toggle('hidden');
  });
  $('#btn-toggle-right').addEventListener('click', () => {
    rightPanel.classList.toggle('hidden');
  });

  // ===== 設定 =====
  const codeBgInput = $('#code-bg-color');
  const codeTextInput = $('#code-text-color');
  const fontSizeSelect = $('#editor-font-size');
  const autoSaveCheck = $('#auto-save');

  function applyCodeColors() {
    document.documentElement.style.setProperty('--code-bg', codeBgInput.value);
    document.documentElement.style.setProperty('--code-text', codeTextInput.value);
  }

  codeBgInput.addEventListener('input', () => {
    applyCodeColors();
    saveSettings();
  });
  codeTextInput.addEventListener('input', () => {
    applyCodeColors();
    saveSettings();
  });

  fontSizeSelect.addEventListener('change', () => {
    quill.root.style.fontSize = fontSizeSelect.value;
    saveSettings();
  });

  function saveSettings() {
    const s = {
      codeBg: codeBgInput.value,
      codeText: codeTextInput.value,
      fontSize: fontSizeSelect.value,
      autoSave: autoSaveCheck.checked
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.codeBg) codeBgInput.value = s.codeBg;
      if (s.codeText) codeTextInput.value = s.codeText;
      if (s.fontSize) {
        fontSizeSelect.value = s.fontSize;
        if (quill) quill.root.style.fontSize = s.fontSize;
      }
      if (typeof s.autoSave === 'boolean') autoSaveCheck.checked = s.autoSave;
      applyCodeColors();
    } catch (e) {}
  }

  // ===== 自動保存 =====
  function startAutoSave() {
    if (autoSaveTimer) clearInterval(autoSaveTimer);
    autoSaveTimer = setInterval(() => {
      if (autoSaveCheck.checked && isDirty) {
        saveAll();
      }
    }, 30000);
  }

  autoSaveCheck.addEventListener('change', () => {
    saveSettings();
    startAutoSave();
  });

  // ===== 保存ボタン =====
  $('#btn-save').addEventListener('click', saveAll);

  // 概要・想定も変更検知
  overviewEl.addEventListener('input', markDirty);
  assumptionsEl.addEventListener('input', markDirty);

  // ===== 初期化 =====
  function init() {
    initQuill();
    loadSettings();
    loadAll();
    // TODO も別途復元
    try {
      const t = localStorage.getItem(TODO_KEY);
      if (t) {
        todos = JSON.parse(t);
        renderTodos();
      }
    } catch (e) {}
    startAutoSave();
    updateTOC();

    // ページ離脱警告
    window.addEventListener('beforeunload', (e) => {
      if (isDirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        saveAll();
      }
    });
  }

  // DOMReady
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();