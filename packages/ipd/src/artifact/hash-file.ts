// 计算产物文件的 SHA-256 内容摘要。
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

export async function hashFile(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}
