// Devices registered for development and ad hoc builds. Apple keeps them a
// year at least: the API can't delete one, only disable it.

import { type Resource, all, one, patch, post } from "./client";

export type DevicePlatform = "IOS" | "MAC_OS";

export interface Device {
  id: string;
  name: string;
  udid: string;
  /** IOS (iPhone, iPad, Apple TV, Vision Pro, Watch) or MAC_OS. */
  platform: string;
  /** IPHONE, IPAD, MAC, APPLE_TV, APPLE_WATCH, APPLE_VISION_PRO, IPOD. */
  deviceClass: string | null;
  model: string | null;
  /** ENABLED or DISABLED. */
  status: string;
  addedDate: string | null;
}

interface DeviceAttributes {
  name: string;
  udid: string;
  platform: string;
  deviceClass?: string | null;
  model?: string | null;
  status: string;
  addedDate?: string | null;
}

export const toDevice = ({ id, attributes }: Resource<DeviceAttributes>): Device => ({
  id,
  name: attributes.name,
  udid: attributes.udid,
  platform: attributes.platform,
  deviceClass: attributes.deviceClass ?? null,
  model: attributes.model ?? null,
  status: attributes.status,
  addedDate: attributes.addedDate ?? null,
});

/** The team's devices, by name. */
export async function listDevices(filter: { platform?: DevicePlatform } = {}): Promise<Device[]> {
  const platform = filter.platform ? `&filter[platform]=${filter.platform}` : "";
  const { data } = await all<DeviceAttributes>(`/v1/devices?limit=200&sort=name${platform}`);
  return data.map(toDevice);
}

/** Registers a device. */
export async function registerDevice(device: { name: string; udid: string; platform: DevicePlatform }): Promise<Device> {
  const created = one(await post<DeviceAttributes>("/v1/devices", { data: { type: "devices", attributes: device } }));
  return created ? toDevice(created) : { id: "", ...device, deviceClass: null, model: null, status: "ENABLED", addedDate: null };
}

/** Renames a device, or turns it on or off. */
export async function updateDevice(id: string, changes: { name?: string; status?: "ENABLED" | "DISABLED" }): Promise<Device | undefined> {
  const updated = one(await patch<DeviceAttributes>(`/v1/devices/${encodeURIComponent(id)}`, { data: { type: "devices", id, attributes: changes } }));
  return updated && toDevice(updated);
}
