// 从包内提示词目录加载稳定的角色协议文本。
import { readFileSync } from "node:fs";

export function loadPrompt(name: string): string {
	return readFileSync(new URL(`../../prompts/${name}.md`, import.meta.url), "utf8").trim();
}
