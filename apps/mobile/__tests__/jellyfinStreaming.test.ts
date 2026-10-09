jest.mock("@/modules/ssl-trust", () => ({
  resolveServerBase: (url: string) => url,
}));

jest.mock("@/services/jellyfin/deviceId", () => ({
  getDeviceId: () => "device",
}));

jest.mock("@/services/local/keys", () => ({
  parseLocalPodcastEpisodeId: () => null,
  parseLocalTrackId: () => null,
}));

const netState = { isCellular: false };
jest.mock("@/services/network", () => ({
  getEffectiveMaxBitRate: (
    maxBitRate: number | null,
    cellularMaxBitRate: number | null,
  ) => (netState.isCellular ? (cellularMaxBitRate ?? maxBitRate) : maxBitRate),
  getEffectiveStreamingFormat: (format: string, cellularFormat: string) =>
    netState.isCellular && cellularFormat !== "same" ? cellularFormat : format,
}));

const authState = {
  serverType: "jellyfin",
  jellyfinRemuxVersion: null as string | null,
};
jest.mock("@/stores/auth", () => ({
  useAuthBase: {
    getState: () => ({
      serverType: authState.serverType,
      url: "http://server",
      username: "u",
      subsonicSalt: "salt",
      subsonicToken: "tok",
      jellyfinAccessToken: "token",
      jellyfinUserId: "user",
      jellyfinRemuxVersion: authState.jellyfinRemuxVersion,
    }),
  },
}));

const appState = {
  maxBitRate: null as number | null,
  cellularMaxBitRate: null as number | null,
  streamingFormat: "raw",
  cellularStreamingFormat: "same",
};
jest.mock("@/stores/app", () => ({
  useAppBase: { getState: () => appState },
}));

import { trackTranscodeInfo } from "@/services/backend/streaming";
import {
  downloadUrl,
  hlsStreamUrl,
  offlineStreamUrl,
  offlineTranscodeSuffix,
  streamUrl,
  willDirectPlay,
} from "@/services/jellyfin/streaming";
import type { StreamFormat } from "@/stores/app";
import type { QueueTrack } from "@/stores/queue";

const track = (extra: Partial<QueueTrack>): QueueTrack =>
  ({ id: "1", url: "http://x", ...extra }) as QueueTrack;

const aacM4a = track({ suffix: "m4a", contentType: "audio/aac" });
const alacM4a = track({ suffix: "m4a", contentType: "audio/alac" });

describe("willDirectPlay", () => {
  const raw = "raw" as StreamFormat;

  it("direct-plays plain accept-list containers in raw mode", () => {
    expect(willDirectPlay(track({ suffix: "mp3" }), raw)).toBe(true);
    expect(willDirectPlay(track({ suffix: "FLAC" }), raw)).toBe(true);
    expect(willDirectPlay(track({ suffix: "ogg" }), raw)).toBe(true);
  });

  it("matches container|codec pairs on both parts", () => {
    expect(willDirectPlay(aacM4a, raw)).toBe(true);
    expect(willDirectPlay(alacM4a, raw)).toBe(false);
    // Unknown codec can't satisfy a paired entry.
    expect(willDirectPlay(track({ suffix: "m4a" }), raw)).toBe(false);
  });

  it("transcodes unlisted or unknown containers", () => {
    expect(willDirectPlay(track({ suffix: "wma" }), raw)).toBe(false);
    expect(willDirectPlay(track({}), raw)).toBe(false);
  });

  it("uses the narrowed accept-list of a concrete format", () => {
    expect(willDirectPlay(aacM4a, "aac")).toBe(true);
    expect(willDirectPlay(alacM4a, "aac")).toBe(false);
    expect(willDirectPlay(track({ suffix: "flac" }), "aac")).toBe(false);
    expect(willDirectPlay(track({ suffix: "ogg" }), "opus")).toBe(true);
  });
});

describe("trackTranscodeInfo", () => {
  beforeEach(() => {
    authState.serverType = "jellyfin";
    appState.streamingFormat = "raw";
    appState.cellularStreamingFormat = "same";
    appState.maxBitRate = null;
    appState.cellularMaxBitRate = null;
    netState.isCellular = false;
  });

  it("predicts the Jellyfin transcode of a raw-mode ALAC m4a (issue #84)", () => {
    const info = trackTranscodeInfo(
      track({ suffix: "m4a", contentType: "audio/alac", bitRate: 640 }),
    );
    expect(info.active).toBe(true);
    expect(info.toLabel).toBe("AAC");
  });

  it("predicts direct play of a raw-mode AAC m4a on Jellyfin", () => {
    expect(trackTranscodeInfo(aacM4a).active).toBe(false);
  });

  it("predicts direct play of an m4a under format=aac on Jellyfin", () => {
    appState.streamingFormat = "aac";
    expect(trackTranscodeInfo(aacM4a).active).toBe(false);
  });

  it("still predicts a bitrate-capped transcode on Jellyfin direct-play containers", () => {
    appState.maxBitRate = 128;
    const info = trackTranscodeInfo(track({ suffix: "flac", bitRate: 1016 }));
    expect(info.active).toBe(true);
    expect(info.toLabel).toBe("AAC · 128 kbps");
  });

  it("keeps Subsonic semantics on Navidrome (raw m4a direct-plays)", () => {
    authState.serverType = "navidrome";
    expect(trackTranscodeInfo(alacM4a).active).toBe(false);
  });

  it("is inactive for the on-device library", () => {
    authState.serverType = "local";
    expect(trackTranscodeInfo(alacM4a).active).toBe(false);
  });

  it("predicts the cellular format's transcode on cellular", () => {
    appState.cellularStreamingFormat = "opus";
    netState.isCellular = true;
    const info = trackTranscodeInfo(aacM4a);
    expect(info.active).toBe(true);
    expect(info.toLabel).toBe("OPUS");
  });
});

describe("streamUrl negotiation params", () => {
  beforeEach(() => {
    authState.serverType = "jellyfin";
    appState.streamingFormat = "raw";
    appState.cellularStreamingFormat = "same";
    netState.isCellular = false;
  });

  it("negotiates the cellular format on cellular", () => {
    appState.cellularStreamingFormat = "opus";
    netState.isCellular = true;
    const url = streamUrl("1");
    expect(url).toContain("Container=opus,ogg");
    expect(url).toContain("AudioCodec=opus");
    expect(url).toContain("TranscodingContainer=ogg");
  });

  it("keeps the permissive raw accept-list on Wi-Fi", () => {
    appState.cellularStreamingFormat = "opus";
    expect(streamUrl("1")).toContain("AudioCodec=aac");
  });
});

// Jellyfin 12 turns `EnableLegacyAuthorization` off by default (PR #16992), and
// the legacy `api_key` query param is gated behind it. `ApiKey` is the ungated
// spelling and is read all the way back to 10.8, so these URLs must never
// regress to the lowercase form — every stream/download would 401.
describe("query-string auth", () => {
  beforeEach(() => {
    authState.serverType = "jellyfin";
  });

  it.each([
    ["streamUrl", () => streamUrl("1")],
    ["hlsStreamUrl", () => hlsStreamUrl("1")],
    ["downloadUrl", () => downloadUrl("1")],
    [
      "offlineStreamUrl",
      () => offlineStreamUrl("1", "raw" as StreamFormat, null),
    ],
  ])("%s authenticates with ApiKey, not api_key", (_name, build) => {
    const url = build();
    expect(url).toContain("ApiKey=token");
    expect(url).not.toContain("api_key=");
  });
});

describe("Remux", () => {
  beforeEach(() => {
    authState.serverType = "jellyfin";
    authState.jellyfinRemuxVersion = "0.19.0";
    appState.streamingFormat = "raw";
    appState.cellularStreamingFormat = "same";
    appState.maxBitRate = null;
    appState.cellularMaxBitRate = null;
    netState.isCellular = false;
  });

  afterAll(() => {
    authState.jellyfinRemuxVersion = null;
  });

  // Remux's universal endpoint always answers with a redirect to an HLS
  // playlist, which the progressive player can't open.
  it("never streams through the universal endpoint", () => {
    expect(streamUrl("1")).not.toContain("/universal");
    appState.streamingFormat = "opus";
    expect(streamUrl("1")).not.toContain("/universal");
  });

  it("serves the untouched source for uncapped raw playback", () => {
    expect(streamUrl("1")).toBe(
      "http://server/Audio/1/stream?Static=true&ApiKey=token&DeviceId=device&Client=Wavio",
    );
    expect(willDirectPlay(track({}), "raw")).toBe(true);
    expect(trackTranscodeInfo(track({ suffix: "flac" })).active).toBe(false);
  });

  it("transcodes a chosen format into Matroska", () => {
    appState.streamingFormat = "opus";
    const url = streamUrl("1");
    expect(url).toContain("/Audio/1/stream.mkv?");
    expect(url).toContain("Container=mkv");
    expect(url).toContain("AudioCodec=opus");
    expect(url).not.toContain("Static=true");
    expect(willDirectPlay(track({ suffix: "opus" }), "opus")).toBe(false);
  });

  it("transcodes raw playback to AAC at the bitrate cap", () => {
    appState.maxBitRate = 128;
    const url = streamUrl("1");
    expect(url).toContain("AudioCodec=aac");
    expect(url).toContain("AudioBitRate=128000");
    // The URL transcodes whatever the source bitrate, so the prediction (which
    // decides between a native seek and a StartTimeTicks reload) must agree.
    const info = trackTranscodeInfo(track({ suffix: "mp3", bitRate: 96 }));
    expect(info.active).toBe(true);
    expect(info.toLabel).toBe("AAC");
  });

  it("follows the cellular settings on cellular", () => {
    appState.cellularStreamingFormat = "mp3";
    appState.cellularMaxBitRate = 96;
    netState.isCellular = true;
    const url = streamUrl("1");
    expect(url).toContain("AudioCodec=mp3");
    expect(url).toContain("AudioBitRate=96000");
  });

  it("seeks within a transcode with StartTimeTicks", () => {
    appState.streamingFormat = "aac";
    expect(streamUrl("1", { timeOffset: 12.5 })).toContain(
      "StartTimeTicks=125000000",
    );
  });

  it("falls back to an opus transcode after a decode error", () => {
    const url = streamUrl("1", { forceTranscode: true });
    expect(url).toContain("/stream.mkv?");
    expect(url).toContain("AudioCodec=opus");
  });

  it("saves offline transcodes as Matroska audio", () => {
    const url = offlineStreamUrl("1", "mp3", 192);
    expect(url).toContain("/Audio/1/stream.mkv?");
    expect(url).toContain("AudioCodec=mp3");
    expect(url).toContain("AudioBitRate=192000");
    expect(offlineTranscodeSuffix("mp3")).toBe("mka");
    expect(offlineTranscodeSuffix("opus")).toBe("mka");
  });

  it("keeps the shared download and HLS routes Remux implements", () => {
    expect(downloadUrl("1")).toContain("/Items/1/Download?ApiKey=token");
    expect(hlsStreamUrl("1")).toContain("/Audio/1/universal?ApiKey=token");
  });
});
