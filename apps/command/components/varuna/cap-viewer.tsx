"use client";

import { Copy, Download, FileCode2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/varuna/empty-state";
import { useCopyToClipboard } from "@/lib/hooks";
import { cssVar } from "@/lib/ramps";
import { cn } from "@/lib/utils";

export type XmlTokenKind = "tag" | "attr" | "value" | "text" | "meta" | "punct";

export interface XmlToken {
  kind: XmlTokenKind;
  text: string;
}

/** Splits the inside of a `<...>` tag into its name, attributes and values. */
function tokenizeTag(tag: string, out: XmlToken[]): void {
  const m = /^(<\/?)([^\s/>]+)([\s\S]*?)(\/?>)$/.exec(tag);
  if (!m) {
    out.push({ kind: "punct", text: tag });
    return;
  }
  out.push({ kind: "punct", text: m[1] ?? "" });
  out.push({ kind: "tag", text: m[2] ?? "" });
  const attrs = m[3] ?? "";
  const attrRe = /(\s+)([^\s=>/]+)(\s*=\s*)?("[^"]*"|'[^']*')?/g;
  let last = 0;
  let a: RegExpExecArray | null;
  while ((a = attrRe.exec(attrs)) !== null) {
    if (a[0].length === 0) {
      attrRe.lastIndex += 1;
      continue;
    }
    if (a.index > last) out.push({ kind: "punct", text: attrs.slice(last, a.index) });
    out.push({ kind: "punct", text: a[1] ?? "" });
    out.push({ kind: "attr", text: a[2] ?? "" });
    if (a[3]) out.push({ kind: "punct", text: a[3] });
    if (a[4]) out.push({ kind: "value", text: a[4] });
    last = a.index + a[0].length;
  }
  if (last < attrs.length) out.push({ kind: "punct", text: attrs.slice(last) });
  out.push({ kind: "punct", text: m[4] ?? "" });
}

/**
 * A small XML tokeniser for display only: declarations and comments, tags, attribute names,
 * attribute values and text. It never validates; the CAP 1.2 schema test lives in Python.
 */
export function tokenizeXml(xml: string): XmlToken[] {
  const out: XmlToken[] = [];
  const re = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<[^>]*>|[^<]+/g;
  for (const piece of xml.match(re) ?? []) {
    if (piece.startsWith("<!--") || piece.startsWith("<?") || piece.startsWith("<![CDATA[")) {
      out.push({ kind: "meta", text: piece });
    } else if (piece.startsWith("<")) {
      tokenizeTag(piece, out);
    } else {
      out.push({ kind: "text", text: piece });
    }
  }
  return out;
}

/** Chart tokens carry the syntax colours so the viewer never borrows the depth ramp. */
const TOKEN_COLOUR: Record<XmlTokenKind, string | null> = {
  tag: cssVar("--chart-1"),
  attr: cssVar("--chart-2"),
  value: cssVar("--chart-4"),
  text: null,
  meta: cssVar("--text-3"),
  punct: cssVar("--text-3"),
};

export interface CapViewerProps {
  /** The CAP 1.2 document, or null before any alert has been raised. */
  xml: string | null;
  /** Download name, e.g. "MUM-20190702T1745-hindmata.cap.xml". */
  filename?: string;
  className?: string;
}

/**
 * CAP 1.2 viewer (CLAUDE.md section 7.5): the document in Geist Mono with tag, attribute and
 * text colouring, plus "Copy CAP" and "Download .xml". Replay alerts carry status Exercise.
 */
export function CapViewer({ xml, filename = "alert.cap.xml", className }: CapViewerProps) {
  const { copy } = useCopyToClipboard();
  const hasXml = typeof xml === "string" && xml.trim().length > 0;

  const download = () => {
    if (!hasXml || typeof document === "undefined") return;
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 pb-3">
        {hasXml ? (
          <>
            <Button variant="outline" size="sm" onClick={() => void copy(xml, "CAP copied")}>
              <Copy data-icon="inline-start" aria-hidden="true" />
              Copy CAP
            </Button>
            <Button variant="outline" size="sm" onClick={download}>
              <Download data-icon="inline-start" aria-hidden="true" />
              Download .xml
            </Button>
          </>
        ) : (
          <>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button variant="outline" size="sm" disabled aria-disabled="true">
                  <Copy data-icon="inline-start" aria-hidden="true" />
                  Copy CAP
                </Button>
              </TooltipTrigger>
              <TooltipContent>Available once an alert has a CAP document</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger render={<span className="inline-flex" />}>
                <Button variant="outline" size="sm" disabled aria-disabled="true">
                  <Download data-icon="inline-start" aria-hidden="true" />
                  Download .xml
                </Button>
              </TooltipTrigger>
              <TooltipContent>Available once an alert has a CAP document</TooltipContent>
            </Tooltip>
          </>
        )}
      </div>

      {hasXml ? (
        <pre
          // Focusable because it scrolls and holds nothing focusable: without this a keyboard
          // user can see the CAP document and never reach the rest of it (WCAG 2.1.1).
          tabIndex={0}
          role="region"
          className="min-h-0 flex-1 overflow-auto rounded-control border border-line bg-ink p-4 type-mono text-text focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-tide/50"
          aria-label="CAP 1.2 document"
        >
          <code>
            {tokenizeXml(xml).map((token, i) => {
              const colour = TOKEN_COLOUR[token.kind];
              return colour ? (
                <span key={i} style={{ color: colour }}>
                  {token.text}
                </span>
              ) : (
                <span key={i}>{token.text}</span>
              );
            })}
          </code>
        </pre>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center rounded-control border border-line bg-ink">
          <EmptyState
            icon={FileCode2}
            title="No CAP document yet"
            description="Alerts raise when a segment stays above its threshold for two cycles."
          />
        </div>
      )}
    </div>
  );
}
