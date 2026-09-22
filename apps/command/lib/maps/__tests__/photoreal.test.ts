import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyPhotorealProbe,
  createCreditStore,
  mergeCredits,
  PHOTOREAL_KEY_HEADER,
  PHOTOREAL_TILESET_URL,
  photorealNotice,
  probePhotorealTileset,
  resetPhotorealVerdicts,
  serverSentence,
  usePhotorealTileset,
  type PhotorealReason,
} from "../photoreal";

const KEY_VAR = "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY";

/**
 * The body `GET https://tile.googleapis.com/v1/3dtiles/root.json` actually returned on
 * 2026-09-23, with the key in an `X-Goog-Api-Key` header, against the Cloud project this build
 * was given: HTTP 403, `PERMISSION_DENIED`, `SERVICE_DISABLED`.
 *
 * Kept verbatim apart from the project number, which is replaced by a placeholder - it is not a
 * secret, but it identifies somebody's Cloud project and the classifier never reads it. Test
 * against the real shape, not against a guess: the two fields that matter here
 * (`details[].reason` and the leading sentence) sit in places a hand-written fake would have got
 * wrong, and this is the exact state the build ships in today.
 */
const SERVICE_DISABLED_403 = JSON.stringify({
  error: {
    code: 403,
    message:
      "Map Tiles API has not been used in project 000000000000 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/tile.googleapis.com/overview?project=000000000000 then retry. If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.",
    status: "PERMISSION_DENIED",
    details: [
      {
        "@type": "type.googleapis.com/google.rpc.ErrorInfo",
        reason: "SERVICE_DISABLED",
        domain: "googleapis.com",
        metadata: {
          containerInfo: "000000000000",
          consumer: "projects/000000000000",
          service: "tile.googleapis.com",
          serviceTitle: "Map Tiles API",
        },
      },
    ],
  },
});

/** The shape Google sends when a key exists and is simply not allowed to do this. */
const REQUEST_DENIED_403 = JSON.stringify({
  error: {
    code: 403,
    message: "The provided API key is not authorized for this service.",
    status: "PERMISSION_DENIED",
  },
});

describe("serverSentence", () => {
  it("quotes Google's own message out of its error envelope", () => {
    expect(serverSentence(SERVICE_DISABLED_403)).toMatch(/^Map Tiles API has not been used/);
  });

  it("falls back to the first line when the body is not Google's JSON", () => {
    expect(serverSentence("\n\n  Bad gateway  \nnginx\n")).toBe("Bad gateway");
  });

  it("gives nothing for an empty body rather than an empty quotation", () => {
    expect(serverSentence("")).toBeUndefined();
    expect(serverSentence("   \n  ")).toBeUndefined();
  });

  it("caps a proxy's HTML error page so it cannot fill a map chip", () => {
    const sentence = serverSentence("x".repeat(500));
    expect(sentence).toHaveLength(200);
    expect(sentence?.endsWith("…")).toBe(true);
  });
});

describe("classifyPhotorealProbe", () => {
  it("reads a 200 as tiles we can draw", () => {
    expect(classifyPhotorealProbe(200, '{"asset":{}}')).toEqual({ kind: "ready" });
  });

  it("names the disabled Map Tiles API from the body this key really returns", () => {
    const state = classifyPhotorealProbe(403, SERVICE_DISABLED_403);
    expect(state).toMatchObject({ kind: "unavailable", reason: "api-disabled" });
  });

  it("separates a disabled service from a refused key, since they are different fixes", () => {
    expect(classifyPhotorealProbe(403, REQUEST_DENIED_403)).toMatchObject({ reason: "refused" });
    expect(classifyPhotorealProbe(403, "")).toMatchObject({ reason: "refused" });
    expect(classifyPhotorealProbe(401, "")).toMatchObject({ reason: "refused" });
  });

  it("treats a referrer complaint as a refusal whatever status carries it", () => {
    expect(
      classifyPhotorealProbe(400, '{"error_message":"RefererNotAllowedMapError"}'),
    ).toMatchObject({ reason: "refused" });
  });

  it("carries the server's own sentence through an unrecognised answer", () => {
    const state = classifyPhotorealProbe(
      404,
      '{"error":{"code":404,"message":"Requested entity was not found."}}',
    );
    expect(state).toMatchObject({ reason: "error" });
    if (state.kind !== "unavailable") throw new Error("expected an unavailable state");
    expect(state.message).toContain("Requested entity was not found.");
  });

  it("still says the status when the server gave no words at all", () => {
    const state = classifyPhotorealProbe(503, "");
    if (state.kind !== "unavailable") throw new Error("expected an unavailable state");
    expect(state.reason).toBe("error");
    expect(state.message).toContain("HTTP 503");
  });
});

describe("photorealNotice", () => {
  const reasons: PhotorealReason[] = ["no-key", "api-disabled", "refused", "offline", "error"];

  it("says what happened and what to do, never only that something went wrong", () => {
    for (const reason of reasons) {
      const notice = photorealNotice(reason);
      expect(notice).not.toMatch(/something went wrong/i);
      // One sentence: a single terminating full stop, at the end.
      expect(notice.trimEnd().endsWith(".")).toBe(true);
      // Every one of them ends in an instruction, after the semicolon that separates the two.
      expect(notice).toContain(";");
    }
  });

  it("names the Map Tiles API and the Cloud project, because that is the state we ship in", () => {
    const notice = photorealNotice("api-disabled");
    expect(notice).toContain("Map Tiles API");
    expect(notice).toMatch(/Google Cloud project/);
    expect(notice).toMatch(/enable/i);
  });

  it("is sentence case, with no ALL-CAPS label and no arrow (CLAUDE.md 6.8)", () => {
    for (const reason of reasons) {
      const notice = photorealNotice(reason);
      expect(notice).not.toMatch(/->|→/);
      // The only shouted tokens allowed are the product's own name and the environment
      // variable's real one - both are spelled that way everywhere else in the app, and a
      // sentence that renamed them to fit a style rule would be a sentence nobody could act on.
      const allowed = new Set(["VARUNA", "NEXT_PUBLIC_GOOGLE_MAPS_API_KEY"]);
      const shouted = notice.match(/\b[A-Z][A-Z_]{3,}\b/g) ?? [];
      expect(shouted.filter((token) => !allowed.has(token))).toEqual([]);
    }
  });
});

describe("probePhotorealTileset", () => {
  it("sends the key in a header and never in the URL", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    await probePhotorealTileset("test-key", fetchImpl as unknown as typeof fetch);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(PHOTOREAL_TILESET_URL);
    expect(url).not.toContain("test-key");
    expect((init.headers as Record<string, string>)[PHOTOREAL_KEY_HEADER]).toBe("test-key");
  });

  it("reads a thrown fetch as the network being gone, not as an API problem", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const state = await probePhotorealTileset("test-key", fetchImpl as unknown as typeof fetch);
    expect(state).toMatchObject({ kind: "unavailable", reason: "offline" });
  });

  it("classifies the real disabled-service answer end to end", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(SERVICE_DISABLED_403, { status: 403 }),
    ) as unknown as typeof fetch;
    const state = await probePhotorealTileset("test-key", fetchImpl);
    expect(state).toMatchObject({ kind: "unavailable", reason: "api-disabled" });
  });
});

describe("mergeCredits", () => {
  it("splits, trims, de-duplicates and sorts into one line", () => {
    expect(
      mergeCredits(["Airbus; Maxar Technologies", "Maxar Technologies;Airbus", "  CNES / Airbus "]),
    ).toBe("Airbus; CNES / Airbus; Maxar Technologies");
  });

  it("does not depend on the order the tiles were traversed in", () => {
    const tiles = ["B;A", "C", "A;C"];
    expect(mergeCredits(tiles)).toBe(mergeCredits([...tiles].reverse()));
  });

  it("drops empty and whitespace-only fragments rather than printing stray semicolons", () => {
    expect(mergeCredits(["Airbus;;", " ; ", "", "  "])).toBe("Airbus");
    expect(mergeCredits([])).toBe("");
    expect(mergeCredits([";;;"])).toBe("");
  });

  it("keeps unicode providers intact and files them by an en collation, not after Z", () => {
    // A code-unit sort would put every accented name after "Zenrin"; an en collation does not.
    expect(mergeCredits(["Zenrin", "Ærial Data", "Landsat / Copernicus"])).toBe(
      "Ærial Data; Landsat / Copernicus; Zenrin",
    );
  });

  it("ignores a tile whose copyright is missing rather than throwing", () => {
    const parts = ["Airbus", undefined, null] as unknown as string[];
    expect(mergeCredits(parts)).toBe("Airbus");
  });
});

describe("createCreditStore", () => {
  it("notifies only when the merged line actually changes", () => {
    const store = createCreditStore();
    const listener = vi.fn();
    store.subscribe(listener);

    store.setCredits(["Airbus; Maxar Technologies"]);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.getCredits()).toBe("Airbus; Maxar Technologies");

    // The same providers in a different order, which is what a traversal gives you many times a
    // second while the camera moves: no listener, therefore no React render.
    store.setCredits(["Maxar Technologies", "Airbus"]);
    expect(listener).toHaveBeenCalledTimes(1);

    store.setCredits(["Airbus", "Zenrin"]);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("stops notifying an unsubscribed listener", () => {
    const store = createCreditStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    unsubscribe();
    store.setCredits(["Airbus"]);
    expect(listener).not.toHaveBeenCalled();
  });

  it("survives a listener that unsubscribes itself mid-notification", () => {
    const store = createCreditStore();
    const second = vi.fn();
    const unsubscribeFirst = store.subscribe(() => unsubscribeFirst());
    store.subscribe(second);
    store.setCredits(["Airbus"]);
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe("usePhotorealTileset", () => {
  beforeEach(() => {
    resetPhotorealVerdicts();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("asks Google nothing while 3D is off", async () => {
    vi.stubEnv(KEY_VAR, "test-key");
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const { result } = renderHook(() => usePhotorealTileset(false));

    expect(result.current).toEqual({ kind: "off" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says so without a round trip when there is no key", async () => {
    vi.stubEnv(KEY_VAR, "");
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const { result } = renderHook(() => usePhotorealTileset(true));

    expect(result.current).toMatchObject({ kind: "unavailable", reason: "no-key" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("probes once and keeps a ready verdict for the life of the tab", async () => {
    vi.stubEnv(KEY_VAR, "test-key");
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const first = renderHook(() => usePhotorealTileset(true));
    await waitFor(() => expect(first.result.current).toEqual({ kind: "ready" }));
    first.unmount();

    const second = renderHook(() => usePhotorealTileset(true));
    await waitFor(() => expect(second.result.current).toEqual({ kind: "ready" }));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-probes after a refusal, so enabling the API does not need a page reload", async () => {
    vi.stubEnv(KEY_VAR, "test-key");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response(SERVICE_DISABLED_403, { status: 403 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchImpl);

    const first = renderHook(() => usePhotorealTileset(true));
    await waitFor(() =>
      expect(first.result.current).toMatchObject({ kind: "unavailable", reason: "api-disabled" }),
    );
    first.unmount();

    const second = renderHook(() => usePhotorealTileset(true));
    await waitFor(() => expect(second.result.current).toEqual({ kind: "ready" }));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
