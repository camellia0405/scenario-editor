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
            // 大きな選択範囲のコードブロック化を軽量化
            'code-block': function () {
              applyCodeBlockLight();
            }
          }
        },
        clipboard: {
          matchVisual: false
        },
        keyboard: {
          bindings: {
            // Ctrl + Alt + 1 → 見出し1
            header1: {
              key: '1',
              ctrlKey: true,
              altKey: true,
              handler: function () {
                this.quill.format('header', 1);
              }
            },
            // Ctrl + Alt + 2 → 見出し2
            header2: {
              key: '2',
              ctrlKey: true,
              altKey: true,
              handler: function () {
                this.quill.format('header', 2);
              }
            },
            // Ctrl + Alt + 3 → 見出し3
            header3: {
              key: '3',
              ctrlKey: true,
              altKey: true,
              handler: function () {
                this.quill.format('header', 3);
              }
            },
            // Ctrl + Alt + 0 → 標準（見出し解除）
            header0: {
              key: '0',
              ctrlKey: true,
              altKey: true,
              handler: function () {
                this.quill.format('header', false);
              }
            }
          }
        }
      },
      placeholder: 'ここに本文を入力するか、左上の「本文から取り込み」からPDF/TXTを読み込んでください...\n\n見出しを使うと左側の目次に自動反映されます。'
    });

    // 変更検知（重い処理はまとめて遅延）
    quill.on('text-change', () => {
      markDirty();
      updateCharCount();
      clearTimeout(window._heavyTimer);
      window._heavyTimer = setTimeout(() => {
        updateTOC();
        attachCodeBlockCopyButtons();
      }, 800);
    });

    // コードブロック用コピーボタンの初期適用
    // ※ MutationObserver は大きな書式変更時に無限ループ化するため使わない
    attachCodeBlockCopyButtons();

    // 初期フォーカス
    quill.focus();
  }

  // ===== コードブロックを行単位で適用（先頭空行・末尾行のはみ出しを防ぐ） =====
  function applyCodeBlockLight() {
    if (!quill) return;
    const range = quill.getSelection(true);
    if (!range) return;

    // 選択を行の先頭〜行末（改行含む）まで広げる
    const fullText = quill.getText();
    let start = range.index;
    let end = range.index + Math.max(range.length, 0);

    while (start > 0 && fullText.charAt(start - 1) !== '\n') {
      start--;
    }
    // 末尾が行の途中なら行末まで含める
    if (end < fullText.length) {
      const nextNl = fullText.indexOf('\n', end);
      end = nextNl === -1 ? fullText.length : nextNl + 1;
    }

    const length = Math.max(end - start, 1);
    const formats = quill.getFormat(start, length);
    const enable = !formats['code-block'];

    // ブロック書式は formatLine が正しい（delete+insert だと行が割れる）
    quill.formatLine(start, length, 'code-block', enable);
  }

  const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  let attachingCodeBtns = false;

  // ===== コードブロック右上にコピーボタンを追加 =====
  function attachCodeBlockCopyButtons() {
    if (!quill || attachingCodeBtns) return;
    attachingCodeBtns = true;
    try {
      const pres = quill.root.querySelectorAll('pre.ql-syntax');
      pres.forEach((pre) => {
        if (pre.querySelector('.code-copy-btn')) return;
        pre.style.position = 'relative';

        const btn = document.createElement('button');
        btn.className = 'code-copy-btn';
        btn.type = 'button';
        btn.title = 'コピー';
        btn.innerHTML = COPY_ICON;
        pre.appendChild(btn);
      });
    } finally {
      attachingCodeBtns = false;
    }
  }

  // コピーはイベント委任（ブロックごとの listener を増やさない）
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest && e.target.closest('.code-copy-btn');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const pre = btn.closest('pre');
    if (!pre) return;
    const text = (pre.innerText || pre.textContent || '').replace(/\s*コピー\s*$/, '');
    try {
      await navigator.clipboard.writeText(text);
    } catch (err) {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    btn.classList.add('copied');
    btn.innerHTML = CHECK_ICON;
    showToast('コードをコピーしました', 'success', 1500);
    setTimeout(() => {
      btn.classList.remove('copied');
      btn.innerHTML = COPY_ICON;
    }, 1500);
  });

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

      // エディタにセット
      // PDFの場合は見出し推定付きの構造化データ、TXTはプレーンテキスト
      if (typeof text === 'object' && text.ops) {
        // Delta形式（見出し付き）
        quill.setContents(text);
      } else {
        const cleaned = cleanImportedText(String(text));
        quill.setText(cleaned);
      }
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

  /**
   * インポートテキストの整形
   * - PDF/TXTの改行位置をそのまま再現する
   * - 30文字折り返しなどの強制改行は行わない
   * - 連続する空行のみ軽く整理（3行以上 → 2行）
   */
  function cleanImportedText(text) {
    return text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .replace(/\n{3,}/g, '\n\n')  // 連続空行を最大2行までに制限
      .trim();
  }

  /**
   * TXT読み込み（文字化け対策）
   * UTF-8 → 失敗っぽい場合は Shift_JIS / EUC-JP を試す
   */
  async function readTextFile(file) {
    const buffer = await file.arrayBuffer();

    // まず UTF-8 で試す
    let text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);

    // 明らかな文字化けパターン（置換文字が多い、または日本語が全く出ないのにバイナリっぽい）を簡易判定
    const replacementCount = (text.match(/\uFFFD/g) || []).length;
    const hasJapanese = /[\u3040-\u30ff\u4e00-\u9faf]/.test(text);

    if (replacementCount > 5 || (!hasJapanese && text.length > 50 && /[\x80-\xff]/.test(String.fromCharCode(...new Uint8Array(buffer.slice(0, 200)))))) {
      // Shift_JIS を試す
      try {
        const sjis = new TextDecoder('shift_jis', { fatal: false }).decode(buffer);
        const sjisReplace = (sjis.match(/\uFFFD/g) || []).length;
        if (sjisReplace < replacementCount && /[\u3040-\u30ff\u4e00-\u9faf]/.test(sjis)) {
          return sjis;
        }
      } catch (e) {}

      // EUC-JP を試す
      try {
        const euc = new TextDecoder('euc-jp', { fatal: false }).decode(buffer);
        if (/[\u3040-\u30ff\u4e00-\u9faf]/.test(euc)) {
          return euc;
        }
      } catch (e) {}
    }

    return text;
  }

  /**
   * PDFテキスト抽出
   * - CMap を有効にして日本語の文字化けを抑制
   * - フォントサイズから見出しを推定し、Quill Delta として返す
   * - 改行位置はPDF上のY座標差から再現
   */
  async function extractPdfText(file) {
    if (typeof pdfjsLib === 'undefined') {
      throw new Error('PDF.js が読み込まれていません。ネットワークを確認してください。');
    }

    const arrayBuffer = await file.arrayBuffer();

    // CMap を指定して日本語フォントの文字化けを防ぐ
    const pdf = await pdfjsLib.getDocument({
      data: arrayBuffer,
      cMapUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/cmaps/',
      cMapPacked: true,
      // 標準フォントのマッピングも有効化
      standardFontDataUrl: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/standard_fonts/'
    }).promise;

    const numPages = pdf.numPages;
    const ops = []; // Quill Delta ops
    let bodyFontSizes = []; // 本文らしいフォントサイズを集計

    // まず全ページのフォントサイズを集めて、本文の標準サイズを推定
    const allItems = [];

    for (let i = 1; i <= numPages; i++) {
      loadingText.textContent = `PDF を解析中... (${i}/${numPages} ページ)`;
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const viewport = page.getViewport({ scale: 1.0 });

      content.items.forEach((item) => {
        if (!item.str || !item.str.trim()) return;
        // transform: [scaleX, skewY, skewX, scaleY, translateX, translateY]
        const fontSize = Math.abs(item.transform[0]) || Math.abs(item.transform[3]) || 12;
        allItems.push({
          str: item.str,
          fontSize,
          y: item.transform[5],
          x: item.transform[4],
          page: i,
          height: viewport.height
        });
        bodyFontSizes.push(fontSize);
      });
    }

    if (allItems.length === 0) {
      throw new Error('このPDFから文字を抽出できませんでした（スキャン画像の可能性があります）。OCR対応版が必要です。');
    }

    // 本文フォントサイズの中央値を求める（外れ値に強い）
    bodyFontSizes.sort((a, b) => a - b);
    const medianFontSize = bodyFontSizes[Math.floor(bodyFontSizes.length / 2)] || 12;

    // 見出し判定の閾値（本文より十分大きいもの）
    const h1Threshold = medianFontSize * 1.6;
    const h2Threshold = medianFontSize * 1.35;
    const h3Threshold = medianFontSize * 1.15;

    // ページごとに行を再構築
    let currentPage = 0;
    let lastY = null;
    let currentLine = [];
    let currentLineFontSize = 0;

    function flushLine() {
      if (currentLine.length === 0) return;

      const lineText = currentLine.join('').replace(/\s+/g, ' ').trim();
      if (!lineText) {
        currentLine = [];
        return;
      }

      // フォントサイズで見出しレベルを判定
      let header = false;
      if (currentLineFontSize >= h1Threshold) {
        header = 1;
      } else if (currentLineFontSize >= h2Threshold) {
        header = 2;
      } else if (currentLineFontSize >= h3Threshold && lineText.length < 40) {
        // 短めの行で少し大きい場合は H3 候補
        header = 3;
      }

      if (header) {
        ops.push({ insert: lineText + '\n', attributes: { header } });
      } else {
        ops.push({ insert: lineText + '\n' });
      }

      currentLine = [];
      currentLineFontSize = 0;
    }

    allItems.forEach((item, idx) => {
      // ページが変わったら空行を入れる
      if (item.page !== currentPage) {
        flushLine();
        if (currentPage !== 0) {
          ops.push({ insert: '\n' });
        }
        currentPage = item.page;
        lastY = null;
      }

      // Y座標が大きく変わったら改行（PDFの改行を再現）
      if (lastY !== null && Math.abs(item.y - lastY) > 6) {
        flushLine();
      }

      currentLine.push(item.str);
      // 行の代表フォントサイズ（最大を採用）
      currentLineFontSize = Math.max(currentLineFontSize, item.fontSize);
      lastY = item.y;
    });

    flushLine();

    // 末尾の余分な改行を整理
    while (ops.length > 0 && ops[ops.length - 1].insert === '\n') {
      ops.pop();
    }
    if (ops.length === 0) {
      ops.push({ insert: '\n' });
    }

    return { ops };
  }

  // ===== 保存 / 読み込み =====
  /** 現在の編集データをオブジェクトとして取得 */
  function getSaveData() {
    return {
      version: 1,
      content: quill ? quill.getContents() : null,
      html: quill ? quill.root.innerHTML : '',
      overview: overviewEl.value,
      assumptions: assumptionsEl.value,
      todos: todos,
      savedAt: new Date().toISOString()
    };
  }

  /** localStorage への自動保存用（従来どおり） */
  function saveToLocalStorage() {
    if (!quill) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(getSaveData()));
      markSaved();
    } catch (e) {
      console.warn('localStorage への保存に失敗', e);
    }
  }

  /**
   * 「名前を付けて保存」
   * Chrome / Edge など File System Access API 対応ブラウザでは保存先を指定可能
   * 非対応ブラウザでは JSON ダウンロードにフォールバック
   */
  async function saveAll() {
    if (!quill) return;

    const data = getSaveData();
    const json = JSON.stringify(data, null, 2);
    const suggestedName = `scenario-${new Date().toISOString().slice(0, 10)}.json`;

    // File System Access API が使える場合（Chrome / Edge など）
    if (window.showSaveFilePicker) {
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{
            description: 'シナリオ編集データ (JSON)',
            accept: { 'application/json': ['.json'] }
          }]
        });
        const writable = await handle.createWritable();
        await writable.write(json);
        await writable.close();

        // 念のため localStorage にもバックアップ
        saveToLocalStorage();
        markSaved();
        showToast('ファイルに保存しました', 'success');
        return;
      } catch (err) {
        // ユーザーがキャンセルした場合は何もしない
        if (err.name === 'AbortError') return;
        console.warn('showSaveFilePicker 失敗、ダウンロードにフォールバック', err);
      }
    }

    // フォールバック：ダウンロード
    downloadBlob(json, suggestedName, 'application/json');
    saveToLocalStorage();
    markSaved();
    showToast('JSONをダウンロードしました（保存先はブラウザの設定に依存）', 'success');
  }

  /** 保存した JSON ファイルを開いて復元 */
  async function openSavedFile() {
    // File System Access API
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{
            description: 'シナリオ編集データ (JSON)',
            accept: { 'application/json': ['.json'] }
          }],
          multiple: false
        });
        const file = await handle.getFile();
        const text = await file.text();
        applyLoadedData(JSON.parse(text));
        showToast(`「${file.name}」を読み込みました`, 'success');
        return;
      } catch (err) {
        if (err.name === 'AbortError') return;
        console.warn('showOpenFilePicker 失敗', err);
        showToast('ファイルを開けませんでした', 'error');
        return;
      }
    }

    // フォールバック：input[type=file]
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        applyLoadedData(JSON.parse(text));
        showToast(`「${file.name}」を読み込みました`, 'success');
      } catch (e) {
        showToast('JSONの読み込みに失敗しました', 'error');
      }
    };
    input.click();
  }

  /** 読み込んだデータをエディタに反映 */
  function applyLoadedData(data) {
    if (!data) return;
    if (data.content) {
      quill.setContents(data.content);
    } else if (data.html) {
      quill.root.innerHTML = data.html;
    }
    if (data.overview != null) overviewEl.value = data.overview;
    if (data.assumptions != null) assumptionsEl.value = data.assumptions;
    if (Array.isArray(data.todos)) {
      todos = data.todos;
      renderTodos();
    }
    updateCharCount();
    updateTOC();
    attachCodeBlockCopyButtons();
    markSaved();
    // localStorage にも反映
    saveToLocalStorage();
  }

  /** 起動時の localStorage 復元 */
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      applyLoadedData(data);
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
  const autoSaveCheck = $('#auto-save'); // 自動保存は無効化（UI削除）

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
      autoSave: false
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
      // 自動保存は無効のため設定を復元しない
      applyCodeColors();
    } catch (e) {}
  }

  // ===== 自動保存は無効 =====
  function startAutoSave() {
    if (autoSaveTimer) {
      clearInterval(autoSaveTimer);
      autoSaveTimer = null;
    }
  }

  // ===== 保存ボタン =====
  $('#btn-save').addEventListener('click', saveAll);
  $('#btn-open-file').addEventListener('click', openSavedFile);

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