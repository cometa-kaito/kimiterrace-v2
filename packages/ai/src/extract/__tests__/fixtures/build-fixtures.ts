/**
 * F01 抽出器の **実バイト smoke E2E** 用 fixture ビルダ (Issue #188 / PR #187 Reviewer M-2)。
 *
 * pdf / docx の単体テストはパーサを `vi.mock` してラッパ契約だけ検証している (binary fixture は脆い、の判断)。
 * だが「pdfjs-dist legacy build / mammoth が **Node ランタイムで実際に動くか**」は一度も CI を通らない。
 * そこで本モジュールは**最小の有効な PDF / DOCX バイトをプログラムで生成**し、smoke テストが実パーサに
 * 食わせて end-to-end を一度通す。
 *
 * **なぜ commit 済 binary ではなくビルダか**: (1) 生成コードはレビュー可能で中身が自明 (opaque な
 * binary blob を信用しない)、(2) 依存追加なし (Node 組み込みのみ)、(3) 再現可能。生成されるのは
 * 実パーサが解釈する**本物のバイト列**なので「実バイトで CI を通す」目的は満たす。
 *
 * テキストは ASCII のみ使う: 最小 PDF は標準 14 フォント Helvetica (WinAnsi) を使うため非 ASCII は
 * 表示エンコードできない。smoke の目的は i18n ではなくランタイム配線の疎通確認。
 */

const enc = new TextEncoder();

/**
 * 最小の**非圧縮** PDF を生成する。Catalog → Pages → Page (Helvetica) → 1 つの text-showing
 * オペレータ (Tj) を持ち、pdfjs の `getTextContent()` が `text` を 1 TextItem として返す。
 * xref のバイトオフセットは生成時に実測して埋める (手書きズレを排除)。
 */
export function buildMinimalPdf(text: string): Uint8Array {
  // PDF 文字列リテラルのエスケープ ( ) \ のみ (ASCII 前提)。
  const esc = text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const content = `BT /F1 24 Tf 72 720 Td (${esc}) Tj ET\n`;
  const contentLen = enc.encode(content).length;
  const bodies = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${contentLen} >>\nstream\n${content}endstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 0; i < bodies.length; i++) {
    offsets[i] = enc.encode(pdf).length; // オブジェクト i+1 の先頭バイトオフセット
    pdf += `${i + 1} 0 obj\n${bodies[i]}\nendobj\n`;
  }

  const xrefStart = enc.encode(pdf).length;
  pdf += `xref\n0 ${bodies.length + 1}\n`;
  pdf += "0000000000 65535 f \n"; // オブジェクト 0 (free)、各行ちょうど 20 バイト
  for (let i = 0; i < bodies.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return enc.encode(pdf);
}

/** CRC-32 (IEEE, ZIP 用)。テーブル不要の素朴実装 (fixture 生成は呼び出し頻度が低い)。 */
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc ^= bytes[i] as number;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

const u16 = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff];
const u32 = (n: number): number[] => [
  n & 0xff,
  (n >>> 8) & 0xff,
  (n >>> 16) & 0xff,
  (n >>> 24) & 0xff,
];

/** STORE 方式 (無圧縮) の最小 ZIP を組む。docx は ZIP コンテナなので mammoth が読める。 */
function buildZip(entries: { name: string; data: Uint8Array }[]): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    const name = enc.encode(e.name);
    const crc = crc32(e.data);
    const size = e.data.length;
    // ローカルファイルヘッダ (method=0 STORE, 無圧縮なので comp=uncomp)
    const localHeader = new Uint8Array([
      ...u32(0x04034b50),
      ...u16(20),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u16(0),
      ...u32(crc),
      ...u32(size),
      ...u32(size),
      ...u16(name.length),
      ...u16(0),
      ...name,
    ]);
    locals.push(localHeader, e.data);
    // セントラルディレクトリヘッダ
    centrals.push(
      new Uint8Array([
        ...u32(0x02014b50),
        ...u16(20),
        ...u16(20),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(crc),
        ...u32(size),
        ...u32(size),
        ...u16(name.length),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u16(0),
        ...u32(0),
        ...u32(offset),
        ...name,
      ]),
    );
    offset += localHeader.length + e.data.length;
  }

  const cdStart = offset;
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const eocd = new Uint8Array([
    ...u32(0x06054b50),
    ...u16(0),
    ...u16(0),
    ...u16(entries.length),
    ...u16(entries.length),
    ...u32(cdSize),
    ...u32(cdStart),
    ...u16(0),
  ]);

  const all = [...locals, ...centrals, eocd];
  const total = all.reduce((n, a) => n + a.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const a of all) {
    out.set(a, p);
    p += a.length;
  }
  return out;
}

/**
 * 最小の有効な .docx (OOXML パッケージ) を生成する。mammoth.extractRawText が必要とする 3 パートを含む:
 * `[Content_Types].xml` / `_rels/.rels` (officeDocument 関係) / `word/document.xml` (本文段落)。
 * `<w:t>` の中身が `extractRawText().value` として返る。
 */
export function buildMinimalDocx(text: string): Uint8Array {
  // XML 特殊文字をエスケープ (ASCII 前提だが & < > は最低限)。
  const x = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const contentTypes =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    "</Types>";
  const rels =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${x}</w:t></w:r></w:p></w:body></w:document>`;

  return buildZip([
    { name: "[Content_Types].xml", data: enc.encode(contentTypes) },
    { name: "_rels/.rels", data: enc.encode(rels) },
    { name: "word/document.xml", data: enc.encode(document) },
  ]);
}
