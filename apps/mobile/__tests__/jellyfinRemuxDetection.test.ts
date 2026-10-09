const mockGet = jest.fn();
jest.mock("@/services/jellyfin/index", () => ({
  __esModule: true,
  default: { get: (...args: unknown[]) => mockGet(...args) },
  buildAuthorizationHeader: () => "",
}));

const mockAuthState = {
  serverVersion: null as string | null,
  jellyfinRemuxVersion: null as string | null,
  setServerVersion: (version: string | null) => {
    mockAuthState.serverVersion = version;
  },
  setJellyfinRemuxVersion: jest.fn((version: string | null) => {
    mockAuthState.jellyfinRemuxVersion = version;
  }),
};
jest.mock("@/stores/auth", () => ({
  useAuthBase: { getState: () => mockAuthState },
}));

import { ping } from "@/services/jellyfin/system";

beforeEach(() => {
  mockGet.mockReset();
  mockAuthState.serverVersion = null;
  mockAuthState.jellyfinRemuxVersion = null;
  mockAuthState.setJellyfinRemuxVersion.mockClear();
});

describe("Jellyfin ping Remux detection", () => {
  it("records the Remux version from /System/Info", async () => {
    mockGet.mockResolvedValue({
      data: { Version: "10.11.8", RemuxVersion: "0.19.0" },
    });
    await ping();
    expect(mockAuthState.jellyfinRemuxVersion).toBe("0.19.0");
    expect(mockAuthState.serverVersion).toBe("10.11.8");
  });

  it("clears it when the server turns out to be plain Jellyfin", async () => {
    mockAuthState.jellyfinRemuxVersion = "0.19.0";
    mockGet.mockResolvedValue({ data: { Version: "10.11.0" } });
    await ping();
    expect(mockAuthState.jellyfinRemuxVersion).toBeNull();
  });

  it("leaves the store alone when nothing changed", async () => {
    mockGet.mockResolvedValue({ data: { Version: "10.11.0" } });
    await ping();
    expect(mockAuthState.setJellyfinRemuxVersion).not.toHaveBeenCalled();
  });
});
