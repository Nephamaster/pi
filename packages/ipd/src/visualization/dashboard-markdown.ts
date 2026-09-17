// 渲染看板所需 Markdown 子集，所有用户文字先转义。
const esc = (value: unknown) =>
	String(value ?? "").replace(/[&<>"']/g, (ch) =>
		ch.charCodeAt(0) === 38
			? "&amp;"
			: ch.charCodeAt(0) === 60
				? "&lt;"
				: ch.charCodeAt(0) === 62
					? "&gt;"
					: ch.charCodeAt(0) === 34
						? "&quot;"
						: "&#39;",
	);
function inlineMarkdown(value: string) {
	const codes: string[] = [];
	const tick = String.fromCharCode(96);
	let html = esc(value).replace(new RegExp(`${tick}([^${tick}]+)${tick}`, "g"), (_match, code) => {
		const token = `@@IPD_CODE_${codes.length}@@`;
		codes.push(`<code>${code}</code>`);
		return token;
	});
	html = html
		.replace(/[*][*]([^*]+)[*][*]/g, "<strong>$1</strong>")
		.replace(/__([^_]+)__/g, "<strong>$1</strong>")
		.replace(/[*]([^*]+)[*]/g, "<em>$1</em>");
	return html.replace(/@@IPD_CODE_([0-9]+)@@/g, (_match, index) => codes[Number(index)] || "");
}

function markdownBlockStart(line: string, fence: string) {
	return (
		line.startsWith(fence) ||
		/^(#{1,6})[ ]+/.test(line) ||
		/^[ ]*[-*+][ ]+/.test(line) ||
		/^[ ]*[0-9]+[.][ ]+/.test(line) ||
		line.startsWith("> ") ||
		/^[ ]*---+[ ]*$/.test(line)
	);
}

export function renderMarkdown(value: string) {
	const newline = String.fromCharCode(10);
	const lines = String(value || "")
		.replaceAll(String.fromCharCode(13), "")
		.split(newline);
	const fence = String.fromCharCode(96, 96, 96);
	const blocks = [];
	let index = 0;
	while (index < lines.length) {
		const line = lines[index];
		if (!line.trim()) {
			index++;
			continue;
		}
		if (line.startsWith(fence)) {
			const code = [];
			index++;
			while (index < lines.length && !lines[index].startsWith(fence)) code.push(lines[index++]);
			if (index < lines.length) index++;
			blocks.push(`<pre><code>${esc(code.join(newline))}</code></pre>`);
			continue;
		}
		const heading = /^(#{1,6})[ ]+(.*)$/.exec(line);
		if (heading) {
			const level = heading[1].length;
			blocks.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
			index++;
			continue;
		}
		if (/^[ ]*[-*+][ ]+/.test(line)) {
			const items = [];
			while (index < lines.length && /^[ ]*[-*+][ ]+/.test(lines[index]))
				items.push(lines[index++].replace(/^[ ]*[-*+][ ]+/, ""));
			blocks.push(`<ul>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ul>`);
			continue;
		}
		if (/^[ ]*[0-9]+[.][ ]+/.test(line)) {
			const items = [];
			while (index < lines.length && /^[ ]*[0-9]+[.][ ]+/.test(lines[index]))
				items.push(lines[index++].replace(/^[ ]*[0-9]+[.][ ]+/, ""));
			blocks.push(`<ol>${items.map((item) => `<li>${inlineMarkdown(item)}</li>`).join("")}</ol>`);
			continue;
		}
		if (line.startsWith("> ")) {
			const quote = [];
			while (index < lines.length && lines[index].startsWith("> ")) quote.push(lines[index++].slice(2));
			blocks.push(`<blockquote>${quote.map(inlineMarkdown).join("<br>")}</blockquote>`);
			continue;
		}
		if (/^[ ]*---+[ ]*$/.test(line)) {
			blocks.push("<hr>");
			index++;
			continue;
		}
		const paragraph = [line];
		index++;
		while (index < lines.length && lines[index].trim() && !markdownBlockStart(lines[index], fence))
			paragraph.push(lines[index++]);
		blocks.push(`<p>${paragraph.map(inlineMarkdown).join("<br>")}</p>`);
	}
	return blocks.join("");
}
