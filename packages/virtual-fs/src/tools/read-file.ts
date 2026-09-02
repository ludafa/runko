/**
 * `read-file`（docs/tech/builtin-tools.md §1.1）：cat -n 风格带行号文本；2000 行/256KB
 * 预算 + offset/limit 分页；二进制与 reference 返回结构化指引而非裸错误；
 * 读取后登记 readState。
 */
import { z } from "zod";
import { defineTool } from "@runko/core";
import type { Tool, ToolReturn } from "@runko/core";
import { NotFoundError, ReferenceNotResolvable } from "../memory.js";
import {
  READ_FILE_MAX_BYTES,
  READ_FILE_MAX_LINES,
  type CreateFileToolsOptions,
  decode,
  describeError,
  errorResult,
  isTextMimeType,
  truncationNotice,
} from "./shared.js";

const inputSchema = z.object({
  path: z.string(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

interface LineSlice {
  bodyLines: string[];
  startLine: number; // 1-indexed
  endLineInclusive: number; // 1-indexed, last included line number
  totalLines: number;
  truncatedBudget: "lines" | "bytes" | undefined;
}

/**
 * 2000 行 / 256KB 是每次调用的硬预算，不论是默认全读还是显式传了更大的
 * limit——工单未明确"显式 limit 是否可突破默认预算"这一歧义，这里按"预算是
 * 工具输出的硬上限"解读（§0.3："每个工具都有输出预算"），比"预算只是默认值"
 * 更符合"截断必须显式标注"这条规则的精神：模型总能靠加大 offset 分页拿到
 * 剩余内容，不需要一次性突破预算。
 */
function sliceLinesWithBudget(lines: string[], offset: number, limit: number | undefined): LineSlice {
  const totalLines = lines.length;
  const start = Math.min(offset, totalLines);
  const requestedEnd = limit !== undefined ? Math.min(start + limit, totalLines) : totalLines;
  const hardCapEnd = Math.min(requestedEnd, start + READ_FILE_MAX_LINES);

  const encoder = new TextEncoder();
  let bytes = 0;
  let end = start;
  let truncatedBudget: "lines" | "bytes" | undefined;
  while (end < hardCapEnd) {
    const line = lines[end] ?? "";
    const lineBytes = encoder.encode(line).length + 1;
    if (end > start && bytes + lineBytes > READ_FILE_MAX_BYTES) {
      truncatedBudget = "bytes";
      break;
    }
    bytes += lineBytes;
    end += 1;
  }
  if (truncatedBudget === undefined && end < requestedEnd) {
    truncatedBudget = "lines"; // hit the 2000-line hard cap before reaching the requested/EOF end
  }

  return {
    bodyLines: lines.slice(start, end),
    startLine: start + 1,
    endLineInclusive: end,
    totalLines,
    truncatedBudget,
  };
}

function renderNumberedLines(bodyLines: string[], startLine: number): string {
  return bodyLines.map((line, i) => `${String(startLine + i).padStart(6, " ")}\t${line}`).join("\n");
}

function formatTextContent(text: string, offset: number, limit: number | undefined): ToolReturn {
  const lines = text.length === 0 ? [] : text.split("\n");
  if (lines.length === 0) {return "(empty file)";}
  if (offset >= lines.length) {
    return errorResult(
      `offset ${offset} is at or beyond the end of the file (it has ${lines.length} line${lines.length === 1 ? "" : "s"}, ` +
        `0-indexed offsets must be less than ${lines.length}). Use a smaller offset.`,
    );
  }

  const slice = sliceLinesWithBudget(lines, offset, limit);
  let body = renderNumberedLines(slice.bodyLines, slice.startLine);
  if (slice.truncatedBudget !== undefined) {
    const reason =
      slice.truncatedBudget === "bytes"
        ? `showing lines ${slice.startLine}-${slice.endLineInclusive} of ${slice.totalLines}; hit the ${READ_FILE_MAX_BYTES / 1024}KB size budget`
        : `showing lines ${slice.startLine}-${slice.endLineInclusive} of ${slice.totalLines}; hit the ${READ_FILE_MAX_LINES}-line budget`;
    body += `\n${truncationNotice(reason, `Continue with offset=${slice.endLineInclusive} (and limit) to read more.`)}`;
  }
  return body;
}

export function createReadFileTool(opts: CreateFileToolsOptions): Tool {
  return defineTool({
    description:
      "Read a file's text content, cat -n style (line numbers are the anchor edit-file uses to locate text). " +
      "Defaults to the whole file, capped at 2000 lines / 256KB per call — use offset/limit (both in lines) to " +
      "page through larger files. Reading registers the file as 'known' for this session, which is required " +
      "before write-file (overwrite) or edit-file can touch it. Binary files and unresolved reference entries " +
      "are not returned as text: instead you get a small structured description (mimeType/size/href/description) " +
      "explaining what the entry is.",
    inputSchema,
    readOnly: true,
    execute: async (input, ctx): Promise<ToolReturn> => {
      let stat;
      try {
        stat = await ctx.fs.stat(input.path);
      } catch (error) {
        if (error instanceof NotFoundError) {
          return errorResult(`"${input.path}" does not exist. Check the path with list-dir or glob before retrying.`);
        }
        return errorResult(`Failed to stat "${input.path}": ${describeError(error)}.`);
      }

      if (stat.type === "dir") {
        return errorResult(`"${input.path}" is a directory, not a file. Use list-dir to see its contents.`);
      }

      if (stat.type === "reference") {
        try {
          const data = await ctx.fs.readFile(input.path);
          if (stat.mtime !== undefined) {opts.readState.set(input.path, stat.mtime);}
          return formatTextContent(decode(data), input.offset ?? 0, input.limit);
        } catch (error) {
          if (error instanceof ReferenceNotResolvable) {
            if (stat.mtime !== undefined) {opts.readState.set(input.path, stat.mtime);}
            return {
              type: "reference",
              path: error.path,
              href: error.href,
              ...(error.mimeType !== undefined ? { mimeType: error.mimeType } : {}),
              ...(error.description !== undefined ? { description: error.description } : {}),
              hint:
                "This path is a reference entry (an external resource, not local content). No resolveReference() " +
                "was injected into this FS, so its content cannot be read directly here — use href to fetch it " +
                "out-of-band, or ask the host to inject a resolver.",
            };
          }
          return errorResult(`Failed to read reference "${input.path}": ${describeError(error)}.`);
        }
      }

      // stat.type === "file"
      if (!isTextMimeType(stat.mimeType)) {
        if (stat.mtime !== undefined) {opts.readState.set(input.path, stat.mtime);}
        const mimeType = stat.mimeType ?? "application/octet-stream";
        const description = stat.annotations?.description;
        return {
          type: "binary",
          path: input.path,
          mimeType,
          ...(stat.size !== undefined ? { size: stat.size } : {}),
          ...(description !== undefined ? { description } : {}),
          hint: `Binary file (${mimeType}${stat.size !== undefined ? `, ${stat.size} bytes` : ""}) cannot be shown as text by read-file.`,
        };
      }

      let data: Uint8Array;
      try {
        data = await ctx.fs.readFile(input.path);
      } catch (error) {
        return errorResult(`Failed to read "${input.path}": ${describeError(error)}.`);
      }
      if (stat.mtime !== undefined) {opts.readState.set(input.path, stat.mtime);}
      return formatTextContent(decode(data), input.offset ?? 0, input.limit);
    },
  });
}
