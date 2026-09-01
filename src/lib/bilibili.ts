export function extractBvid(value: string) {
  const match = value.trim().match(/BV[0-9A-Za-z]{10}/i);
  if (!match) throw new Error("请输入包含 BV 号的 B 站普通视频链接");
  return `BV${match[0].slice(2)}`;
}
