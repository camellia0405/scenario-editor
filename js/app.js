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

  // ===== ふりがな（指定した文字だけ） =====
  function registerRubyBlot() {
    const Inline = Quill.import('blots/inline');
    class RubyBlot extends Inline {
      static create(value) {
        const node = super.create();
        node.setAttribute('data-rt', value || '');
        return node;
      }
      static formats(node) {
        return node.getAttribute('data-rt') || '';
      }
      format(name, value) {
        if (name === RubyBlot.blotName) {
          if (value) this.domNode.setAttribute('data-rt', value);
          else this.unwrap();
        } else {
          super.format(name, value);
        }
      }
    }
    RubyBlot.blotName = 'ruby';
    RubyBlot.tagName = 'SPAN';
    RubyBlot.className = 'ql-ruby';
    Quill.register(RubyBlot);
  }

  function escapeAttr(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function normalizeCheckTitle(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim() || '判定';
  }

  function syncCheckCardPayload(card) {
    if (!card) return;
    const titleEl = card.querySelector('.check-card-title');
    const successEl = card.querySelector('[data-field="success"]');
    const failEl = card.querySelector('[data-field="fail"]');
    const data = {
      title: titleEl ? titleEl.textContent.trim() : '',
      lead: '',
      success: successEl ? (successEl.innerText || '').replace(/\u00a0/g, ' ').trim() : '',
      fail: failEl ? (failEl.innerText || '').replace(/\u00a0/g, ' ').trim() : ''
    };
    card.dataset.payload = JSON.stringify(data);
    return data;
  }

  function buildCheckCardNode(value, node) {
    const data = value || { title: '判定', lead: '', success: '', fail: '' };
    node.className = 'check-card';
    node.setAttribute('contenteditable', 'false');
    node.dataset.payload = JSON.stringify({
      title: data.title || '判定',
      lead: '',
      success: data.success || '',
      fail: data.fail || ''
    });

    const copySvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';

    node.innerHTML = `
      <div class="check-card-header">
        <span class="check-card-title">${escapeHtml(data.title || '判定')}</span>
        <button type="button" class="check-copy" data-copy="title" title="見出しをコピー">${copySvg}</button>
      </div>
      <div class="check-card-row success">
        <span class="check-badge success">成功</span>
        <div class="check-card-body" data-field="success" contenteditable="true" data-placeholder="成功時の文章を入力">${escapeHtml(data.success || '').replace(/\n/g, '<br>')}</div>
        <button type="button" class="check-copy" data-copy="success" title="成功をコピー">${copySvg}</button>
      </div>
      <div class="check-card-row fail">
        <span class="check-badge fail">失敗</span>
        <div class="check-card-body" data-field="fail" contenteditable="true" data-placeholder="失敗時の文章を入力">${escapeHtml(data.fail || '').replace(/\n/g, '<br>')}</div>
        <button type="button" class="check-copy" data-copy="fail" title="失敗をコピー">${copySvg}</button>
      </div>
    `;
    return node;
  }

  function registerCheckCardBlot() {
    const BlockEmbed = Quill.import('blots/block/embed');
    class CheckCardBlot extends BlockEmbed {
      static create(value) {
        const node = super.create();
        return buildCheckCardNode(value, node);
      }
      static value(node) {
        try {
          return JSON.parse(node.dataset.payload || '{}');
        } catch (e) {
          return { title: '判定', lead: '', success: '', fail: '' };
        }
      }
    }
    CheckCardBlot.blotName = 'checkCard';
    CheckCardBlot.tagName = 'DIV';
    CheckCardBlot.className = 'check-card';
    Quill.register(CheckCardBlot);
  }

  function copyTextSafe(text) {
    const value = text || '';
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(value);
    }
    const ta = document.createElement('textarea');
    ta.value = value;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  function applyCheckCard() {
    if (!quill) return;
    const range = quill.getSelection(true);
    if (!range || range.length === 0) {
      showToast('カードの見出しにする文字を選択してください', 'error', 2200);
      return;
    }
    const title = normalizeCheckTitle(quill.getText(range.index, range.length));
    quill.deleteText(range.index, range.length, 'user');
    quill.insertEmbed(range.index, 'checkCard', {
      title,
      lead: '',
      success: '',
      fail: ''
    }, 'user');
    quill.insertText(range.index + 1, '\n', 'user');
    markDirty();
  }

  function applyRuby() {
    if (!quill) return;
    const range = quill.getSelection(true);
    if (!range || range.length === 0) {
      showToast('ふりがなを振る文字を選択してください', 'error', 2000);
      return;
    }
    const current = quill.getFormat(range);
    const existing = typeof current.ruby === 'string' ? current.ruby : '';
    const rt = window.prompt('読み仮名を入力してください（空欄で解除）', existing);
    if (rt === null) return;
    const value = rt.trim();
    quill.formatText(range.index, range.length, 'ruby', value || false, 'user');
    markDirty();
  }

  // ===== Quill 初期化 =====
  function initQuill() {
    registerRubyBlot();
    registerCheckCardBlot();
    const toolbarOptions = [
      [{ header: [1, 2, 3, 4, 5, false] }],
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
            // Ctrl + Alt + 4 → 見出し4
            header4: {
              key: '4',
              ctrlKey: true,
              altKey: true,
              handler: function () {
                this.quill.format('header', 4);
              }
            },
            // Ctrl + Alt + 5 → 見出し5
            header5: {
              key: '5',
              ctrlKey: true,
              altKey: true,
              handler: function () {
                this.quill.format('header', 5);
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

    // コードブロック用コピーボタン（エディタ外オーバーレイ）
    attachCodeBlockCopyButtons();
    quill.root.addEventListener('scroll', () => {
      updateFloatingCopyButtons();
    });
    window.addEventListener('resize', () => {
      updateFloatingCopyButtons();
    });

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

    requestAnimationFrame(updateFloatingCopyButtons);
  }

  const COPY_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
  const CHECK_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>`;

  let floatCopyLayer = null;

  function getFloatCopyLayer() {
    if (floatCopyLayer && document.body.contains(floatCopyLayer)) return floatCopyLayer;
    const container = document.querySelector('.ql-container') || document.querySelector('.editor-area');
    if (!container) return null;
    container.classList.add('has-copy-layer');
    floatCopyLayer = document.createElement('div');
    floatCopyLayer.className = 'code-copy-layer';
    container.appendChild(floatCopyLayer);
    return floatCopyLayer;
  }

  function updateFloatingCopyButtons() {
    if (!quill) return;
    const layer = getFloatCopyLayer();
    if (!layer) return;

    const container = layer.parentElement;
    const contRect = container.getBoundingClientRect();
    const pres = quill.root.querySelectorAll('pre');

    layer.innerHTML = '';

    pres.forEach((pre) => {
      const preRect = pre.getBoundingClientRect();
      if (preRect.bottom < contRect.top || preRect.top > contRect.bottom) return;

      const btn = document.createElement('button');
      btn.className = 'code-copy-btn code-copy-float';
      btn.type = 'button';
      btn.title = 'コピー';
      btn.innerHTML = COPY_ICON;
      btn.style.top = (preRect.top - contRect.top + 8) + 'px';
      btn.style.left = (preRect.right - contRect.left - 36) + 'px';
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        e.stopPropagation();
      });
      btn.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        const text = pre.innerText || pre.textContent || '';
        try {
          await navigator.clipboard.writeText(text);
        } catch (err) {
          const ta = document.createElement('textarea');
          ta.value = text;
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
      layer.appendChild(btn);
    });
  }

  function attachCodeBlockCopyButtons() {
    updateFloatingCopyButtons();
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
    const headings = editorEl.querySelectorAll('h1, h2, h3, h4, h5');
    toc.innerHTML = '';

    if (headings.length === 0) {
      toc.innerHTML = '<p class="toc-empty">見出し（H1〜H5）を追加するとここに表示されます</p>';
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

    const MAX_IMPORT_BYTES = 40 * 1024 * 1024; // 40MB
    if (file.size > MAX_IMPORT_BYTES) {
      showToast('ファイルが大きすぎます（40MBまで）', 'error', 4000);
      fileInput.value = '';
      return;
    }

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
    const normalized = text
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
    return reflowParagraphLines(normalized.split('\n')).join('\n').trim();
  }

  function countChar(str, ch) {
    return (str.split(ch).length - 1);
  }

  function isInsideUnclosedQuote(str) {
    return countChar(str, '「') > countChar(str, '」');
  }

  /** 1行で完結した短いセリフ・項目 */
  function isCompleteShortQuote(line) {
    return /^「[^「」]+」$/.test(line) && line.length <= 60;
  }

  /** 見出し・項目行とみなすか（途中切れの「… は含めない） */
  function isHeadingOrItemLine(line) {
    const t = (line || '').trim();
    if (!t) return false;

    // 途中で切れたセリフは見出しにしない
    if (isInsideUnclosedQuote(t)) return false;

    // 1行で完結したセリフは項目として行を維持
    if (isCompleteShortQuote(t)) return true;

    // 記号で始まる見出し・項目（「 は上で処理済み）
    if (/^[◆■●▲▼★☆◇○◎□【『〈《〔]/.test(t)) return true;
    if (/^※/.test(t) && t.length <= 40) return true;
    if (/^[-・▪▫‣◦]/.test(t) && t.length <= 40) return true;
    if (/^(第[0-9０-９一二三四五六七八九十百]+[章節項話]|[0-9０-９]+[\.．、\)）])/.test(t)) return true;
    if (/^【.+】$/.test(t)) return true;
    if (/^（※/.test(t) && t.length <= 80) return true;

    // 短い括弧付きタイトル（◆以外の「名前（役職）」など）
    if (
      t.length <= 28 &&
      !/[。！？!?．…]$/.test(t) &&
      !/[、,]$/.test(t) &&
      /[（(【]/.test(t) &&
      !t.startsWith('「')
    ) {
      return true;
    }
    return false;
  }

  /**
   * 本文は文末まで結合、未閉じの「」は閉じるまで結合
   * 見出し・完結セリフは改行を維持
   */
  function reflowParagraphLines(lines) {
    const sentenceEnd = /[。！？!?．…]$/;
    const result = [];
    let buffer = '';

    const flush = () => {
      if (buffer) {
        result.push(buffer);
        buffer = '';
      }
    };

    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].replace(/\s+$/, '').trim();

      if (!trimmed) {
        if (!isInsideUnclosedQuote(buffer)) {
          flush();
          if (result.length === 0 || result[result.length - 1] !== '') {
            result.push('');
          }
        }
        continue;
      }

      // セリフ未閉じの間は見出し判定せず結合
      if (isInsideUnclosedQuote(buffer)) {
        buffer += trimmed;
        if (!isInsideUnclosedQuote(buffer)) flush();
        continue;
      }

      if (isHeadingOrItemLine(trimmed)) {
        flush();
        result.push(trimmed);
        continue;
      }

      buffer = buffer ? buffer + trimmed : trimmed;

      if (isInsideUnclosedQuote(buffer)) continue;
      if (sentenceEnd.test(buffer) || isCompleteShortQuote(buffer)) {
        flush();
      }
    }

    flush();
    return result
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .split('\n');
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
    const rawLines = []; // { text, header }
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
        rawLines.push({ text: lineText, header });
      } else {
        rawLines.push({ text: lineText, header: false });
      }

      currentLine = [];
      currentLineFontSize = 0;
    }

    allItems.forEach((item, idx) => {
      // ページが変わったら空行を入れる
      if (item.page !== currentPage) {
        flushLine();
        if (currentPage !== 0) {
          rawLines.push({ text: '', header: false });
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

    // 見出しは行を維持、本文は文末まで結合してから Delta 化
    const ops = [];
    let paraBuf = [];

    function flushPara() {
      if (paraBuf.length === 0) return;
      const reflowed = reflowParagraphLines(paraBuf);
      reflowed.forEach((line) => {
        ops.push({ insert: (line || '') + '\n' });
      });
      paraBuf = [];
    }

    rawLines.forEach((row) => {
      if (row.header) {
        flushPara();
        ops.push({ insert: row.text + '\n', attributes: { header: row.header } });
        return;
      }
      if (isHeadingOrItemLine(row.text)) {
        flushPara();
        ops.push({ insert: row.text + '\n' });
        return;
      }
      paraBuf.push(row.text);
    });
    flushPara();

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
      todos: todos,
      savedAt: new Date().toISOString()
    };
  }

  /** ブラウザ内バックアップ（手動保存時・復元時） */
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
        if (file.size > 20 * 1024 * 1024) {
          showToast('JSONが大きすぎます（20MBまで）', 'error', 4000);
          return;
        }
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
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      showToast('不正な保存データです', 'error');
      return;
    }
    if (data.content && Array.isArray(data.content.ops)) {
      quill.setContents(data.content);
    } else if (typeof data.html === 'string' && data.html) {
      const delta = quill.clipboard.convert(data.html);
      quill.setContents(delta);
    }
    if (Array.isArray(data.todos)) {
      todos = data.todos
        .filter((t) => t && typeof t.text === 'string')
        .map((t) => ({ text: String(t.text).slice(0, 500), done: !!t.done }));
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
      fontSize: fontSizeSelect.value
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
applyCodeColors();
    } catch (e) {}
  }

  // ===== 保存ボタン =====
  $('#btn-save').addEventListener('click', saveAll);
  $('#btn-open-file').addEventListener('click', openSavedFile);
  const btnRuby = $('#btn-ruby');
  if (btnRuby) btnRuby.addEventListener('click', applyRuby);
  const btnCheckCard = $('#btn-check-card');
  if (btnCheckCard) btnCheckCard.addEventListener('click', applyCheckCard);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest && e.target.closest('.check-copy');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    const card = btn.closest('.check-card');
    if (!card) return;
    const payload = syncCheckCardPayload(card) || {};
    const kind = btn.getAttribute('data-copy');
    let text = '';
    if (kind === 'success') text = payload.success || '';
    else if (kind === 'fail') text = payload.fail || '';
    else if (kind === 'title') text = payload.title || '';
    else {
      text = [
        payload.title || '',
        payload.success ? `成功：${payload.success}` : '成功：',
        payload.fail ? `失敗：${payload.fail}` : '失敗：'
      ].filter((v) => v !== '').join('\n');
    }
    copyTextSafe(text).then(() => showToast('コピーしました', 'success', 1400));
  });

  document.addEventListener('input', (e) => {
    const body = e.target.closest && e.target.closest('.check-card-body');
    if (!body) return;
    const card = body.closest('.check-card');
    syncCheckCardPayload(card);
    markDirty();
  });

  document.addEventListener('keydown', (e) => {
    if (!e.target.closest || !e.target.closest('.check-card-body')) return;
    e.stopPropagation();
  });

  // ===== 検索・置換 =====
  const findBar = $('#find-bar');
  const findInput = $('#find-input');
  const replaceInput = $('#replace-input');
  const findCountEl = $('#find-count');
  const findCaseEl = $('#find-case');
  let findMatches = [];
  let findIndex = -1;

  function getEditorText() {
    if (!quill) return '';
    const t = quill.getText();
    return t.endsWith('\n') ? t.slice(0, -1) : t;
  }

  function collectFindMatches() {
    findMatches = [];
    const needle = findInput.value;
    if (!needle) {
      findIndex = -1;
      findCountEl.textContent = '0/0';
      return;
    }
    const hay = getEditorText();
    const caseSensitive = findCaseEl.checked;
    const src = caseSensitive ? hay : hay.toLowerCase();
    const q = caseSensitive ? needle : needle.toLowerCase();
    let from = 0;
    while (from <= src.length - q.length) {
      const pos = src.indexOf(q, from);
      if (pos === -1) break;
      findMatches.push({ index: pos, length: needle.length });
      from = pos + Math.max(needle.length, 1);
    }
    if (findMatches.length === 0) {
      findIndex = -1;
      findCountEl.textContent = '0/0';
    } else {
      if (findIndex < 0 || findIndex >= findMatches.length) findIndex = 0;
      findCountEl.textContent = `${findIndex + 1}/${findMatches.length}`;
    }
  }

  function selectCurrentMatch() {
    if (!quill || findIndex < 0 || !findMatches[findIndex]) return;
    const m = findMatches[findIndex];
    quill.setSelection(m.index, m.length, 'silent');
    const bounds = quill.getBounds(m.index, m.length);
    if (bounds && quill.root) {
      const editor = quill.root;
      const top = bounds.top + editor.scrollTop;
      if (top < editor.scrollTop || top > editor.scrollTop + editor.clientHeight - 40) {
        editor.scrollTop = Math.max(0, top - 80);
      }
    }
    findCountEl.textContent = `${findIndex + 1}/${findMatches.length}`;
  }

  function openFindBar(focusReplace) {
    findBar.classList.remove('hidden');
    if (quill) {
      const sel = quill.getSelection(true);
      if (sel && sel.length > 0) {
        findInput.value = quill.getText(sel.index, sel.length);
      }
    }
    collectFindMatches();
    if (findMatches.length) selectCurrentMatch();
    setTimeout(() => {
      (focusReplace ? replaceInput : findInput).focus();
      (focusReplace ? replaceInput : findInput).select();
    }, 0);
  }

  function closeFindBar() {
    findBar.classList.add('hidden');
    findMatches = [];
    findIndex = -1;
    if (quill) quill.focus();
  }

  function findNext() {
    collectFindMatches();
    if (!findMatches.length) {
      showToast('一致する文字列がありません', 'error', 1600);
      return;
    }
    findIndex = (findIndex + 1) % findMatches.length;
    selectCurrentMatch();
  }

  function findPrev() {
    collectFindMatches();
    if (!findMatches.length) {
      showToast('一致する文字列がありません', 'error', 1600);
      return;
    }
    findIndex = (findIndex - 1 + findMatches.length) % findMatches.length;
    selectCurrentMatch();
  }

  function replaceOne() {
    collectFindMatches();
    if (!findMatches.length) {
      showToast('一致する文字列がありません', 'error', 1600);
      return;
    }
    if (findIndex < 0) findIndex = 0;
    const m = findMatches[findIndex];
    const replacement = replaceInput.value;
    quill.deleteText(m.index, m.length, 'user');
    quill.insertText(m.index, replacement, 'user');
    collectFindMatches();
    if (findMatches.length) {
      if (findIndex >= findMatches.length) findIndex = 0;
      selectCurrentMatch();
    } else {
      findCountEl.textContent = '0/0';
    }
    markDirty();
  }

  function replaceAll() {
    collectFindMatches();
    if (!findMatches.length) {
      showToast('一致する文字列がありません', 'error', 1600);
      return;
    }
    const replacement = replaceInput.value;
    const count = findMatches.length;
    // 後ろから置換してインデックスずれを防ぐ
    const matches = findMatches.slice().reverse();
    matches.forEach((m) => {
      quill.deleteText(m.index, m.length, 'silent');
      quill.insertText(m.index, replacement, 'silent');
    });
    collectFindMatches();
    findCountEl.textContent = findMatches.length ? `${findIndex + 1}/${findMatches.length}` : '0/0';
    markDirty();
    updateCharCount();
    showToast(`${count} 件を置換しました`, 'success', 1800);
  }

  $('#btn-find').addEventListener('click', () => openFindBar(false));
  $('#btn-find-close').addEventListener('click', closeFindBar);
  $('#btn-find-next').addEventListener('click', findNext);
  $('#btn-find-prev').addEventListener('click', findPrev);
  $('#btn-replace-one').addEventListener('click', replaceOne);
  $('#btn-replace-all').addEventListener('click', replaceAll);
  findInput.addEventListener('input', () => {
    collectFindMatches();
    if (findMatches.length) {
      findIndex = 0;
      selectCurrentMatch();
    }
  });
  findCaseEl.addEventListener('change', () => {
    collectFindMatches();
    if (findMatches.length) selectCurrentMatch();
  });
  findInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) findPrev();
      else findNext();
    }
  });
  replaceInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      replaceOne();
    }
  });

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
    updateTOC();

    // ページ離脱警告（未保存時）
    window.addEventListener('beforeunload', (e) => {
      if (!isDirty) return;
      e.preventDefault();
    });

    // キーボードショートカット
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key === 's') {
        e.preventDefault();
        saveAll();
        return;
      }
      if (mod && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        openFindBar(false);
        return;
      }
      if (mod && (e.key === 'h' || e.key === 'H')) {
        e.preventDefault();
        openFindBar(true);
        return;
      }
      if (mod && e.altKey && (e.key === 'r' || e.key === 'R')) {
        e.preventDefault();
        applyRuby();
        return;
      }
      if (e.key === 'F3') {
        e.preventDefault();
        if (findBar.classList.contains('hidden')) openFindBar(false);
        if (e.shiftKey) findPrev();
        else findNext();
        return;
      }
      if (e.key === 'Escape' && !findBar.classList.contains('hidden')) {
        e.preventDefault();
        closeFindBar();
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