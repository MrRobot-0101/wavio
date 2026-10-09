import axios from "axios";
import { buildAuthorizationHeader } from "@/services/jellyfin/index";

export type JellyfinAuthResponse = {
  AccessToken: string;
  ServerId: string;
  User: {
    Id: string;
    Name: string;
    Policy?: { IsAdministrator?: boolean };
  };
};

export const authenticateByName = async (
  url: string,
  username: string,
  password: string,
  extraHeaders?: Record<string, string>,
): Promise<JellyfinAuthResponse> => {
  const baseURL = url.replace(/\/+$/, "");
  const rsp = await axios
    .create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
        // After `extraHeaders`: this carries the client/device identity the
        // server needs to open the session, so a user-configured
        // `Authorization` header must not shadow it.
        Authorization: buildAuthorizationHeader(null),
      },
    })
    .post<JellyfinAuthResponse>("/Users/AuthenticateByName", {
      Username: username,
      Pw: password,
    });
  return rsp.data;
};

export type JellyfinSystemInfo = {
  ServerName: string;
  Version: string;
  Id: string;
  OperatingSystem?: string;
  // Only present on Remux, which otherwise reports itself as Jellyfin.
  RemuxVersion?: string;
};

export const getSystemInfo = async (
  url: string,
  extraHeaders?: Record<string, string>,
): Promise<JellyfinSystemInfo> => {
  const baseURL = url.replace(/\/+$/, "");
  const rsp = await axios
    .create({
      baseURL,
      headers: {
        "Content-Type": "application/json",
        ...extraHeaders,
        Authorization: buildAuthorizationHeader(null),
      },
    })
    .get<JellyfinSystemInfo>("/System/Info/Public");
  return rsp.data;
};
