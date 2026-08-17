import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import Schema from "@deepseek-ai/schemastery";
import { BlockAssembler, createUserMessage } from "@deepseek-ai/dsh-llm";
import { defineTool } from "@deepseek-ai/dsh-tools";

//#region src/index.ts
const name = "dsh-deepseek-vision";
/** `tools` 注册工具，`llm` 发起识图调用，`attachments` 提供图片的持久化通路。 */
const inject = [
	"tools",
	"llm",
	"attachments"
];
/** `read_image` 接受的扩展名到媒体类型；字节层校验仍由 attachment 服务负责。 */
const IMAGE_MEDIA_TYPES = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif"
};
const Config = Schema.object({
	provider: Schema.string().default("bailian").description("识图供应商路由名"),
	model: Schema.string().default("qwen3.8-max").description("识图模型 id"),
	maxTokens: Schema.natural().default(4e3).description("单次识图的输出上限"),
	reasoningEffort: Schema.string().default("off").description("识图调用的 reasoning effort；读数式提问用 off")
});
/**
* 断言目标路由声明了 image 输入。与 `read_image` 的门禁同源：查的是
* `resolveModelInfo(provider, model).inputModalities`。
* @param ctx - 提供 `llm` 服务的上下文。
* @param config - 识图路由配置。
* @param signal - 可选取消信号。
* @throws 路由未声明 image 输入时抛出，错误信息给出可直接照抄的配置片段。
*/
async function assertVisionRoute(ctx, config, signal) {
	if ((await ctx.llm.resolveModelInfo(config.provider, config.model, signal)).inputModalities?.includes("image") !== true) throw new Error(`dsh-deepseek-vision: 路由 "${config.provider}/${config.model}" 未声明 image 输入。 在 $DSH_HOME/settings.yaml 的 llm-pi-ai.providers 下补上该路由，并在其 models 条目里写 input: [text, image]； 未声明 image 的路由会被图像通路的门禁拒绝，这与 read_image 的行为一致。`);
}
/**
* 把一张本地图片存入 attachment 服务，换回可进模型上下文的引用。
* @param ctx - 提供 `attachments` 服务的上下文。
* @param path - 图片的绝对路径。
* @returns 持久化后的图像引用。
* @throws 扩展名不是受支持的图片格式，或部署的 attachment 策略不接受该媒体类型。
*/
async function commitImage(ctx, path) {
	const mediaType = IMAGE_MEDIA_TYPES[extname(path).toLowerCase()];
	if (mediaType === void 0) throw new Error(`dsh-deepseek-vision: "${path}" 不是 PNG/JPEG/WebP/GIF。 image_path 接受三种形式：文件绝对路径、http(s) 图片地址、或上下文里 \`[图片 …]\` 提示中的附件 id（带不带 attachment= 前缀都可以）。`);
	if (!ctx.attachments.imageLimits.mediaTypes.includes(mediaType)) throw new Error(`dsh-deepseek-vision: 本部署不接受 ${mediaType} 图片`);
	let data;
	try {
		data = await readFile(path);
	} catch (error) {
		throw new Error(`dsh-deepseek-vision: 读不到 "${path}"：${error instanceof Error ? error.message : String(error)}。 image_path 接受三种形式：文件绝对路径、http(s) 图片地址、或上下文 \`[图片 …]\` 提示中的附件 id（带不带 attachment= 前缀都可以）。`, { cause: error });
	}
	return ctx.attachments.saveImage({
		data,
		mediaType,
		name: basename(path)
	});
}
/**
* 向识图路由发一次带图请求，返回纯文本输出。
* @param ctx - 提供 `llm` 与 `attachments` 服务的上下文。
* @param config - 识图路由配置。
* @param imagePath - 图片的绝对路径。
* @param prompt - 提问。
* @param signal - 可选取消信号。
* @returns 模型输出的文本。
* @throws 调用失败或输出被 `maxTokens` 截断时抛出。
*/
async function askVision(ctx, config, imagePath, prompt, signal) {
	const ref = await commitImage(ctx, imagePath);
	const assembler = new BlockAssembler();
	const options = {
		provider: config.provider,
		model: config.model,
		maxTokens: config.maxTokens,
		reasoningEffort: config.reasoningEffort,
		messages: [createUserMessage({
			content: [{
				type: "image",
				attachment: ref
			}, {
				type: "text",
				text: prompt
			}],
			source: {
				kind: "plugin",
				plugin: name
			}
		})],
		...signal === void 0 ? {} : { signal }
	};
	for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
	const finish = assembler.finish;
	if (finish.kind === "error" || finish.kind === "aborted") throw new Error(`dsh-deepseek-vision: 识图调用失败（${finish.failure.code}）：${finish.failure.message}`);
	if (finish.kind === "max-tokens") throw new Error(`dsh-deepseek-vision: 识图输出被 maxTokens=${config.maxTokens} 截断。请调高插件配置的 maxTokens，或把问题问得更具体 —— 具体问题的回答本来也更短、更可靠。`);
	return assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
}
/**
* 图片落盘目录。命名规则完整地留在本文件 —— `llm-deepseek` 的本地补丁只打印附件 id，
* 不推算路径，因此改这里不会与本体失配 —— 两边各写一份规则的话，改一边就会静默失配。
*
* 附件 id 形如 `sha256:<hex>`，冒号在 APFS 上合法但在别处不是，统一替换。
*/
const SPILL_DIR = join(tmpdir(), "dsh-deepseek-vision");
/** 附件 id → 落盘路径，由 {@link spillImages} 填充，{@link resolveImageArg} 查询。 */
const spilled = /* @__PURE__ */ new Map();
/** 由附件 id 与媒体类型推出落盘路径。 */
function spillPath(attachmentId, mediaType) {
	const extension = Object.entries(IMAGE_MEDIA_TYPES).find(([, type]) => type === mediaType)?.[0] ?? ".png";
	return join(SPILL_DIR, `${attachmentId.replace(/[^a-zA-Z0-9._-]/g, "-")}${extension}`);
}
/**
* 远程图片的下载上限。识图按像素计费，超大图既贵又会被降采样。
* 检查发生在 body 读完之后 —— 想真正「早失败」需先看 `Content-Length`，
* 但那个头不保证存在，所以这里换成读完再判，代价是超限图会白下一次。
*/
const MAX_REMOTE_BYTES = 20 * 1024 * 1024;
/**
* 下载一张远程图片到落盘目录。
*
* 文档（飞书、Notion、网页）里的图片是 URL，既不是本地文件也不是 DSH 附件，
* 没有这条路径时模型只能看到一个 `<img>` 标签而无从下手。
*
* 只接受 `Content-Type: image/*`：URL 来自文档正文，属于外部内容，
* 拿回来的若不是图片就直接拒绝，不猜也不落盘。
* @param url - http/https 图片地址。
* @returns 落盘后的绝对路径。
* @throws 请求失败、类型不是图片、或超过 {@link MAX_REMOTE_BYTES} 时抛出。
*/
async function fetchRemoteImage(url) {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`dsh-deepseek-vision: 下载图片失败 HTTP ${response.status}。 若该图需要登录态（飞书、Notion 等私有文档），请先用对应的 skill 或带凭据的命令把它下载到本地，再把本地路径传给本工具。`);
	const contentType = (response.headers.get("content-type") ?? "").split(";")[0].trim();
	const mediaType = Object.values(IMAGE_MEDIA_TYPES).includes(contentType) ? contentType : void 0;
	if (mediaType === void 0) throw new Error(`dsh-deepseek-vision: ${url} 返回的是 ${contentType || "未知类型"}，只支持 PNG / JPEG / WebP / GIF。` + (contentType.includes("svg") ? " SVG 等矢量格式请先转成位图再传。" : " 请确认该地址直接指向图片文件，而不是包含图片的网页。"));
	const data = Buffer.from(await response.arrayBuffer());
	if (data.byteLength > MAX_REMOTE_BYTES) {
		const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
		throw new Error(`dsh-deepseek-vision: 图片 ${mb(data.byteLength)}，超过上限 ${mb(MAX_REMOTE_BYTES)}。 识图按像素计费，超大图既贵又会被降采样。请先裁剪或压缩到上限以内再传，或只截取你真正要看的那一块 —— 局部图的判定精度本来也更高。`);
	}
	await mkdir(SPILL_DIR, { recursive: true });
	const path = join(SPILL_DIR, `remote-${createHash("sha256").update(url).digest("hex").slice(0, 32)}${Object.entries(IMAGE_MEDIA_TYPES).find(([, type]) => type === mediaType)?.[0] ?? ".png"}`);
	await writeFile(path, data);
	return path;
}
/**
* 解析工具收到的图片参数：文件路径、`attachment=<id>`、或 http(s) 图片地址。
* @param raw - 工具参数原值。
* @returns 可读取的绝对路径。
* @throws 该 id 没有落盘记录时抛出，并说明它只在图片出现过的会话里有效。
*/
async function resolveImageArg(raw) {
	const trimmed = raw.trim();
	if (/^https?:\/\//i.test(trimmed)) return fetchRemoteImage(trimmed);
	const id = /^attachment[=:]\s*(\S+)$/.exec(trimmed)?.[1] ?? trimmed;
	const hit = spilled.get(id);
	if (hit !== void 0) return hit;
	if (!id.includes("/") && !id.includes("\\") && /^[a-z0-9]+:/i.test(id)) throw new Error(`dsh-deepseek-vision: 附件 ${id} 没有落盘记录。 该形式只在本次进程内、图片出现过的会话里有效；否则请给文件路径或 http(s) 地址。`);
	return trimmed;
}
/**
* 把消息里的图片落到磁盘，**不改动任何内容块**。
*
* 不改内容是关键：界面渲染的就是这些块，替换掉图片块会让用户看到一串路径而不是一张图。
* 纯文本模型看不到图这件事，由 `llm-deepseek` 的本地补丁在序列化前的最后一刻处理 ——
* 那时消息已经写进会话日志、界面也已渲染完毕。
*
* 内容寻址意味着同一张图重复出现只写一次，重复写入是幂等的。
* @param ctx - 提供 `attachments` 服务的上下文。
* @param blocks - 内容块。
*/
async function spillImages(ctx, blocks) {
	const images = blocks.filter((block) => block.type === "image");
	if (images.length === 0) return;
	await mkdir(SPILL_DIR, { recursive: true });
	for (const block of images) {
		const ref = block.attachment;
		const path = spillPath(ref.attachmentId, ref.mediaType);
		try {
			await writeFile(path, (await ctx.attachments.readImage(ref)).data);
			spilled.set(ref.attachmentId, path);
		} catch {}
	}
}
/**
* 判断当前请求所走的路由是否接受图片输入。
*
* 判据与 `read_image` 门禁、`api-proxy` 的图片准入完全一致：`inputModalities` 明确含 `image` 才算接受。
*
* 唯一用途是让 `deepseek_vision` 在调用方本身就是多模态模型时自我拒绝 —— 它直接看更准也更省。
* 这同时是官方多模态上线时的自动让位机制：DeepSeek 声明 `image` 那天，本工具自己退出。
* 解析不出路由时返回 false，即**不拒绝**：宁可多转一手，也好过让一次正常提问失败。
* @param ctx - 提供 `llm` 服务的上下文。
* @param agent - 当前 agent，用于解析实际生效的路由。
* @param signal - 可选取消信号。
* @returns 路由明确声明接受图片时为 true。
*/
async function routeAcceptsImages(ctx, agent, signal) {
	const owner = agent;
	const routed = owner?.session?.requestHeader?.()?.config;
	const provider = routed?.provider ?? owner?.options?.provider;
	const model = routed?.model ?? owner?.options?.model;
	if (provider === void 0 || model === void 0) return false;
	try {
		return (await ctx.llm.resolveModelInfo(provider, model, signal)).inputModalities?.includes("image") === true;
	} catch {
		return false;
	}
}
/**
* 注册 `deepseek_vision` 工具，并在 `agent/pre-step` 上把出现过的图片落盘。
* @param ctx - 注册作用域；执行期使用其 `llm` 与 `attachments` 服务。
* @param config - 已校验的插件配置。
*/
function apply(ctx, config) {
	ctx.on("agent/pre-step", async (payload, next) => {
		const decision = await next();
		if (decision.kind !== "enter") return decision;
		for (const message of decision.messages) if (Array.isArray(message.content)) await spillImages(ctx, message.content);
		return decision;
	});
	ctx.tools.register(defineTool({
		name: "deepseek_vision",
		description: "看一张图并回答关于它的问题。图片不进入本模型的上下文 —— 它被转交给配置的多模态模型，只有回答的文字回到这里。用户粘贴图片时，你看到的是一行 `[图片 …]` 提示；想知道图上是什么，把提示里的附件 id 传给本工具。",
		parameters: {
			image_path: {
				type: "string",
				required: true,
				description: "三选一：图片的绝对路径；http(s) 图片地址（文档、网页里的图直接传 URL）；或上下文 `[图片 …]` 提示里的附件 id（`attachment=<id>` 或裸 id 都行）。"
			},
			question: {
				type: "string",
				required: true,
				description: "要问的问题。问得越具体，回答越可靠；「这是什么」这类开放问题只会得到概览。"
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					image_path: {
						type: "string",
						required: true
					},
					question: {
						type: "string",
						required: true
					},
					answer: {
						type: "string",
						required: true
					}
				}
			},
			render: (_args, value) => [{
				type: "text",
				text: value.answer
			}]
		},
		isConcurrencySafe: () => true,
		async execute(args, exec) {
			if (await routeAcceptsImages(ctx, exec.agent, exec.signal)) throw new Error("dsh-deepseek-vision: 当前模型本身就能看图，请直接看，不要用 deepseek_vision 转一手。 本工具只服务于看不到图片内容的纯文本模型。");
			await assertVisionRoute(ctx, config, exec.signal);
			const resolved = await resolveImageArg(args.image_path);
			const answer = await askVision(ctx, config, resolved, args.question, exec.signal);
			if (answer.trim().length === 0) throw new Error("dsh-deepseek-vision: 识图返回空内容");
			return {
				image_path: resolved,
				question: args.question,
				answer: answer.trim()
			};
		},
		presentCall(args) {
			return {
				card: "generic",
				title: `Look: ${args.question}`,
				kind: "read",
				locations: [{ path: args.image_path }]
			};
		}
	}));
}

//#endregion
export { Config, apply, inject, name };