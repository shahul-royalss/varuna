"use client";

import type { ReactNode } from "react";

import { formatIst } from "@/lib/format";
import { useReplayStore } from "@/lib/stores/replay";
import { cn } from "@/lib/utils";

/** What the phone shows before any alert has been raised. */
export const DEFAULT_PHONE_MESSAGE =
  "No alerts yet. The ward officer's phone shows the next alert here.";

export interface PhoneMessage {
  id: string;
  /** Message body as the ward officer reads it. */
  text: string;
  /** Sent time, ISO 8601 with +05:30. */
  time?: string;
  /**
   * The map snapshot above the text: a node renders it, `null` draws the empty slot (the alert
   * has a snapshot that has not arrived), `undefined` draws no slot.
   */
  snapshot?: ReactNode | null;
}

export interface PhoneMockProps {
  messages: PhoneMessage[];
  /** Status-bar clock, ISO 8601; defaults to the replay clock. */
  simTime?: string;
  className?: string;
}

/**
 * The ward officer's phone (CLAUDE.md section 7.5): a 40 px-radius frame on `--ink`, a status
 * bar with the wordmark and the sim time, and a dark chat in which VARUNA's messages appear as
 * `--deep` bubbles with a tide accent. Nothing here animates in Phase 0; the pop and shake
 * (motion M16) arrive with real alerts and respect reduced motion.
 */
export function PhoneMock({ messages, simTime, className }: PhoneMockProps) {
  const storeSimTime = useReplayStore((s) => s.simTime);
  const clock = formatIst(simTime ?? storeSimTime);

  return (
    <div
      role="figure"
      aria-label="Ward officer's phone"
      className={cn(
        "mx-auto w-full max-w-[320px] rounded-phone border border-line bg-ink p-2",
        className,
      )}
    >
      <div className="flex h-[560px] flex-col overflow-hidden rounded-[32px] border border-line bg-ink">
        <div className="flex h-8 shrink-0 items-center justify-between px-5 type-micro text-text-2">
          <span className="font-medium text-text">VARUNA</span>
          <span className="num">{clock}</span>
        </div>

        <div className="flex shrink-0 items-center gap-3 border-y border-line bg-deep px-4 py-2">
          <span
            aria-hidden="true"
            className="flex size-8 items-center justify-center rounded-full bg-tide-soft type-small font-semibold text-tide"
          >
            V
          </span>
          <div className="min-w-0">
            <p className="truncate type-small font-medium text-text">VARUNA alerts</p>
            <p className="type-micro text-text-3">Ward officer</p>
          </div>
        </div>

        {/* Focusable: the message list scrolls and the cards in it are not controls, so a
            keyboard user could otherwise see the first message and no others (WCAG 2.1.1). */}
        <ol
          tabIndex={0}
          className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-tide/50"
          aria-label="Messages"
        >
          {messages.length === 0 ? (
            <li className="self-center rounded-control bg-well px-3 py-2 text-center type-micro text-text-2">
              {DEFAULT_PHONE_MESSAGE}
            </li>
          ) : (
            messages.map((message) => (
              <li
                key={message.id}
                className="max-w-[88%] self-start rounded-control border-l-2 border-tide bg-deep p-3"
              >
                {message.snapshot === undefined ? null : message.snapshot === null ? (
                  <div className="mb-2 flex aspect-[4/3] items-center justify-center rounded-control border border-dashed border-line bg-well type-micro text-text-3">
                    Map snapshot arrives with the alert
                  </div>
                ) : (
                  <div className="mb-2 overflow-hidden rounded-control">{message.snapshot}</div>
                )}
                <p className="whitespace-pre-line type-small text-text">{message.text}</p>
                {message.time ? (
                  <p className="num mt-1 text-right type-micro text-text-3">
                    {formatIst(message.time)}
                  </p>
                ) : null}
              </li>
            ))
          )}
        </ol>

        <div className="flex shrink-0 items-center gap-2 border-t border-line bg-deep px-3 py-2">
          <span className="flex-1 rounded-chip border border-line bg-well px-3 py-1.5 type-micro text-text-3">
            Message
          </span>
        </div>
      </div>
    </div>
  );
}
