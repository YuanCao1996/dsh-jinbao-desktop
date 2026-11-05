// 播报正文的收口：模型经常忽略"最多两句"的指令，真实数据里平均 167 字、最长 533 字，
// 35/66 条带段落。这里做确定性收敛——去 Markdown、去段落、只留两句话、上限 68 字。
const SENTENCE_END = /[。！？!?.]/;

export function condenseAdvice(text, { maxChars = 68, maxSentences = 2 } = {}) {
  let value = String(text ?? '');
  if (!value.trim()) return '';
  // Markdown 与常见排版噪音
  value = value
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\*\*|__|`/g, '')
    .replace(/^[\s>*#\-\u2022]+/gm, '')
    .replace(/\r\n?/g, '\n');
  // 段落压成一句话之间：换行/多空白一律变单个空格
  value = value.replace(/\s+/g, ' ').trim();
  if (!value) return '';

  // 取前 maxSentences 句（以中文/西文句末标点切分，分号也算一句的边界）
  const sentences = [];
  let buffer = '';
  for (const ch of value) {
    buffer += ch;
    if (SENTENCE_END.test(ch)) {
      sentences.push(buffer.trim());
      buffer = '';
      if (sentences.length >= maxSentences) break;
    }
  }
  if (sentences.length < maxSentences && buffer.trim()) sentences.push(buffer.trim());
  // 中文句末不需要空格，西文句末需要，否则会粘成一个词
  let result = sentences.reduce((acc, s, i) => (i && /^[A-Za-z]/.test(s) ? acc + ' ' : acc) + s, '');

  if (result.length > maxChars) {
    const chars = Array.from(result);
    const clipped = chars.slice(0, maxChars).join('');
    let cut = Math.max(clipped.lastIndexOf('，'), clipped.lastIndexOf('；'), clipped.lastIndexOf('、'), clipped.lastIndexOf(','));
    let body = cut >= Math.floor(maxChars * 0.5) ? clipped.slice(0, cut) : clipped;
    body = body.replace(/[，、；,;.。！？!?\s]+$/, '');
    result = body + '。';
  }
  return result.trim();
}
