import * as vscode from 'vscode';
import * as path from 'path';
import { mimeOf, mediaTypeOf, type MediaType } from '../util/images';
import { checkMediaBytes, REF_MEDIA_LIMITS, type MediaSize } from '../util/mediaBytes';
import { dedupeName } from '../favorites/favorites';
import { mediaDeclSnippet } from '../refs';
import { showTransientWarning } from '../util/notify';

/**
 * Markdown 图片语法的正则：匹配 `![alt](路径)`，路径可选 `<>` 包裹。
 * 两种形式分两个捕获组——尖括号形式 `<...>` 内部可含空格与半角括号（取非 `>`），
 * 普通形式取非 `)`。「右键插入引用」对含空格/半角括号的路径用尖括号包裹，
 * 解析端必须能完整读回，否则这类参考图会被判读取失败而中断生成。
 */
export const IMAGE_REGEX = /!\[[^\]]*\]\(\s*(?:<([^>]*)>|([^)]+?))\s*\)/g;

/** 从一次匹配中取出路径（尖括号组优先，否则普通组） */
export function refPath(m: RegExpMatchArray): string {
	return (m[1] ?? m[2] ?? '').trim();
}

/** 解析正文中所有图片引用，按首次出现顺序去重编号 */
export function parseImageRefs(content: string): { order: string[]; indexByPath: Map<string, number> } {
	const order: string[] = [];
	const indexByPath = new Map<string, number>();
	for (const match of content.matchAll(IMAGE_REGEX)) {
		const relPath = refPath(match);
		if (relPath && !indexByPath.has(relPath)) {
			indexByPath.set(relPath, order.length + 1);
			order.push(relPath);
		}
	}
	return { order, indexByPath };
}

/** 一条媒体声明：alt（命名引用用的名字）、原始路径、媒体大类 */
export interface MediaDecl {
	alt: string;
	path: string;
	type: MediaType;
}

/** 名字表条目：命名引用 [名] 替换成 【@${标签}${index}】 时取用 */
export interface NameEntry {
	type: MediaType;
	index: number;
}

/**
 * 解析正文里所有 `![alt](路径)` 媒体声明，按出现顺序返回。
 * alt 单独从整段匹配上提取（共享 IMAGE_REGEX 只捕获路径，不动其捕获组）。
 */
export function parseMediaDecls(content: string): MediaDecl[] {
	const decls: MediaDecl[] = [];
	for (const m of content.matchAll(IMAGE_REGEX)) {
		const relPath = refPath(m);
		if (!relPath) {
			continue;
		}
		const alt = (m[0].match(/^!\[([^\]]*)\]/)?.[1] ?? '').trim();
		decls.push({ alt, path: relPath, type: mediaTypeOf(path.extname(relPath)) });
	}
	return decls;
}

/**
 * 由声明列表构建名字表：每类从 1 起独立编号（按声明出现顺序）。
 * 三类非法输入第一时间抛错（产品决策：声明必须规范）：
 * - alt 为空：提示词应经「插入引用」或 AI 生成，空名声明无法被 [名] 引用；
 * - 两条声明 alt 相同：命名引用 [名] 会歧义；
 * - 同一路径声明多个名字：上传按路径去重只传一张，所有别名最终都指向同一个【@图片N】，
 *   别名差异在模型侧完全丢失，只会误导作者以为模型能区分，故直接报错要求合并。
 * 每条声明路径唯一后，按类型计数的编号天然与按路径去重的上传下标对齐。
 */
export function buildNameTable(decls: MediaDecl[]): Map<string, NameEntry> {
	const counters: Record<MediaType, number> = { image: 0, audio: 0, video: 0 };
	const altByPath = new Map<string, string>();
	const table = new Map<string, NameEntry>();
	for (const d of decls) {
		if (!d.alt) {
			throw new Error(`提示词存在未命名声明：![](${d.path})，请补写名字 ![名](路径) 或用右键「插入引用」`);
		}
		if (table.has(d.alt)) {
			throw new Error(`提示词存在重名引用：${d.alt}`);
		}
		const firstAlt = altByPath.get(d.path);
		if (firstAlt !== undefined) {
			throw new Error(`同一文件声明了多个名字：${d.path}（[${firstAlt}] 与 [${d.alt}]），同一张图只能用一个名字`);
		}
		altByPath.set(d.path, d.alt);
		counters[d.type] += 1;
		table.set(d.alt, { type: d.type, index: counters[d.type] });
	}
	return table;
}

/** 媒体大类 → 命名引用标签 */
const MEDIA_LABEL: Record<MediaType, string> = { image: '图片', audio: '音频', video: '视频' };

/** 命名引用正则：声明删除后剩下的 `[名]`，`(?!\()` 跳过 markdown 链接 `[文字](url)` */
const NAMED_REF_REGEX = /\[([^\[\]]+)\](?!\()/g;

/**
 * 找出声明了但正文里没被 `[名]` 引用的名字（去重）。
 * 声明名与引用名不一致（如声明 `![李樱三视图]` 但正文写 `[李樱]`）会让图片被上传却无 `【@图片N】`
 * 指向、`[名]` 当字面文本残留——这是易踩的静默错误，调用方据此弹警告提醒（但不拦截生成）。
 * 前置条件：入参声明须已过 buildNameTable（无空 alt），否则会产出空字符串告警项。
 */
export function findUnreferencedDecls(content: string, decls: MediaDecl[]): string[] {
	const stripped = content.replace(IMAGE_REGEX, '');
	const referenced = new Set<string>();
	for (const m of stripped.matchAll(NAMED_REF_REGEX)) {
		referenced.add(m[1].trim());
	}
	return [...new Set(decls.filter((d) => !referenced.has(d.alt)).map((d) => d.alt))];
}

/**
 * 生成发给模型的 prompt：先整体删除 `![...](...)` 声明（只删语法本身，前后空白保留），
 * 再把命中名字表的 `[名]` 替换为 `【@图片N】`/`【@音频N】`/`【@视频N】`，未命中原样保留。
 * 纯函数（不读盘），生成与编辑链路共用。
 */
export function replaceMediaRefs(content: string, table: Map<string, NameEntry>): string {
	const stripped = content.replace(IMAGE_REGEX, '');
	return stripped.replace(NAMED_REF_REGEX, (full, name: string) => {
		const hit = table.get(name.trim());
		return hit ? `【@${MEDIA_LABEL[hit.type]}${hit.index}】` : full;
	});
}

/** 解析后的提示词：替换图片语法后的正文、按序参考图 base64、参考图原文件名（与 images 等长，归档用） */
interface PromptResult {
	prompt: string;
	images: string[];
	/** 归档落盘文件名（保留原名，重名已去重），与 archivePrompt 的引用一一对应 */
	names: string[];
	/** 归档用正文：图片引用改写为指向任务 input/ 的 markdown，可直接右键重新生成 */
	archivePrompt: string;
}

/** 归档参考图文件名去重：保留原名，同名后续追加序号（a.png、a-1.png…），与 archiveInputs 落盘一致 */
export function dedupeArchiveNames(names: string[]): string[] {
	const used = new Set<string>();
	return names.map((name) => {
		const final = dedupeName(used, name);
		used.add(final);
		return final;
	});
}

/**
 * 把正文里的每处图片语法替换为指向任务文件夹 input/ 归档参考图的 markdown 声明 `![alt](input/原名)`，
 * 用于把提示词正文归档成可「直接右键生成」的 MD。序号取 indexBy（共用 parseImageRefs 编号表），
 * fileNames 是 archiveInputs 落盘的最终文件名（已去重），按序号顺序排列（fileNames[N-1] 即第 N 张）。
 * 保留原始 alt——命名引用 `[alt]` 依赖声明 alt 才能在重生成时替换为 `【@图片N】`。
 * 含空格/括号的名字由 mediaDeclSnippet 用尖括号包裹。未在编号表中的引用原样保留。
 */
export function archiveImageRefs(content: string, indexBy: Map<string, number>, fileNames: string[]): string {
	return content.replace(IMAGE_REGEX, (full: string, bracketed?: string, plain?: string) => {
		const key = (bracketed ?? plain ?? '').trim();
		const index = indexBy.get(key);
		if (index === undefined) {
			return full;
		}
		const alt = (full.match(/^!\[([^\]]*)\]/)?.[1] ?? '').trim();
		return mediaDeclSnippet(alt, `input/${fileNames[index - 1]}`);
	});
}

/**
 * 解析 Markdown 正文为发给后端的 prompt + 有序参考媒体：
 * - 按首次出现顺序编号（同一文件声明多个名字属非法输入，由 buildNameTable 报错）；
 * - 相对 Markdown 所在目录读取参考媒体，转成 base64 data URI；
 * - 删声明 + 把命名引用 `[名]` 替换为 `【@图片N】`/`【@音频N】`/`【@视频N】`。
 * @param allowNonImage true 时不对音/视频引用报错（即梦全能参考视频模型可直接吃音/视频素材）。
 */
export async function buildPrompt(
	mdUri: vscode.Uri,
	content: string,
	allowNonImage = false
): Promise<PromptResult> {
	const { order, indexByPath } = parseImageRefs(content);

	// 多数绘图后端只吃图片：正文引用里出现音/视频就尽早报错，不读盘不上传。
	// 生成与预览共用 buildPrompt，一处守住两条路。
	if (!allowNonImage) {
		const nonImage = order.filter((p) => mediaTypeOf(path.extname(p)) !== 'image');
		if (nonImage.length) {
			throw new Error(`当前模型不支持音视频参考（仅即梦视频模型支持），请移除引用：${nonImage.join('、')}`);
		}
	}

	// 声明解析放在读盘之前，同名声明等硬错误尽早失败，不浪费读图
	const decls = parseMediaDecls(content);
	const table = buildNameTable(decls);
	// 声明了却没被 [名] 引用：只弹警告不拦截——这类图仍会被上传为参考图，只是正文缺 【@图片N】 指针
	const unused = findUnreferencedDecls(content, decls);
	if (unused.length) {
		showTransientWarning(`以下声明的图片未被引用（检查 [名] 是否与声明名一致）：${unused.join('、')}`);
	}

	// 读盘前先按 stat 拦超大素材（宽松档，只拦明显传错的文件）：读进来就要转 base64 常驻内存。
	// stat 不到的（路径写错、文件不存在）在这里跳过，交给下面的读盘循环统一报「读取失败」。
	const sizes: MediaSize[] = [];
	for (const relPath of order) {
		try {
			const stat = await vscode.workspace.fs.stat(vscode.Uri.joinPath(mdUri, '..', relPath));
			sizes.push({ name: relPath, size: stat.size });
		} catch {
			// 忽略：读盘循环会把它记进 failed
		}
	}
	const oversize = checkMediaBytes(sizes, REF_MEDIA_LIMITS);
	if (oversize) {
		throw new Error(oversize);
	}

	// 按顺序读取每张参考媒体，转 base64
	const images: string[] = [];
	const baseNames: string[] = [];
	const failed: string[] = [];
	for (const relPath of order) {
		const ext = path.extname(relPath);
		const fileUri = vscode.Uri.joinPath(mdUri, '..', relPath);
		try {
			const bytes = await vscode.workspace.fs.readFile(fileUri);
			images.push(`data:${mimeOf(ext)};base64,${Buffer.from(bytes).toString('base64')}`);
			baseNames.push(path.basename(relPath));
		} catch {
			failed.push(relPath);
		}
	}
	if (failed.length) {
		throw new Error(`以下参考图读取失败：${failed.join('、')}`);
	}

	// 发给模型的 prompt：删声明 + 命名引用替换为【@图片N】。
	// 编号口径：buildNameTable 已保证每条声明路径唯一（同路径多名字报错），
	// 按类型计数的编号与 images[] 按路径去重的上传下标对齐。
	const prompt = replaceMediaRefs(content, table);
	// 归档文件名：保留原名、重名去重，归档正文与 input/ 落盘共用，引用才能对上
	const fileNames = dedupeArchiveNames(baseNames);
	const archivePrompt = archiveImageRefs(content, indexByPath, fileNames);

	return { prompt, images, names: fileNames, archivePrompt };
}
