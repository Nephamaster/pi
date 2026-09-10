// 为模型可见的 IPD 文本块添加稳定且可识别的边界标签。
const PROMPT_TAG = /^[a-z][a-z0-9_]*$/;

export function wrapPromptBlock(tag: string, content: string): string {
	if (!PROMPT_TAG.test(tag)) throw new Error(`Invalid prompt block tag: ${tag}`);
	return `<${tag}>\n\n${content.trim()}\n\n</${tag}>`;
}
