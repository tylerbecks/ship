// Signing in the developer account: certificates, the bundle ids apps are
// signed for, and provisioning profiles. Private keys are never here: a
// certificate is made from a signing request whose key stays in the Mac's
// Keychain.

import { createHash } from "node:crypto";
import { ShipError } from "../ui";
import { type Resource, all, del, get, many, one, post, relationshipId } from "./client";

// MARK: Certificates

export interface Certificate {
  id: string;
  /** Like "Apple Distribution: Ada Lovelace (TEAM123456)". */
  name: string;
  /** Apple's CertificateType, like DISTRIBUTION or DEVELOPER_ID_APPLICATION_G2. */
  type: string;
  serialNumber: string;
  platform: string | null;
  expirationDate: string | null;
  /** The SHA-1 of the certificate, as `security find-identity` prints it (uppercase hex). */
  sha1: string | null;
  /** The certificate itself (DER, base64): public, it goes in profiles and the Keychain. */
  content: string | null;
}

interface CertificateAttributes {
  name?: string;
  displayName?: string;
  certificateType?: string;
  serialNumber?: string;
  platform?: string | null;
  expirationDate?: string | null;
  certificateContent?: string | null;
}

/** The SHA-1 fingerprint of a base64 DER certificate, uppercase hex. */
export const certificateSha1 = (content: string) => createHash("sha1").update(Buffer.from(content, "base64")).digest("hex").toUpperCase();

export function toCertificate({ id, attributes }: Resource<CertificateAttributes>): Certificate {
  const content = attributes.certificateContent ?? null;
  return {
    id,
    name: attributes.name || attributes.displayName || "",
    type: attributes.certificateType ?? "",
    serialNumber: attributes.serialNumber ?? "",
    platform: attributes.platform ?? null,
    expirationDate: attributes.expirationDate ?? null,
    sha1: content ? certificateSha1(content) : null,
    content,
  };
}

/** The team's certificates, newest expiry first; `types` limits them to those CertificateTypes. */
export async function listCertificates(types: string[] = []): Promise<Certificate[]> {
  const filter = types.length ? `&filter[certificateType]=${types.join(",")}` : "";
  const { data } = await all<CertificateAttributes>(`/v1/certificates?limit=200${filter}`);
  return data.map(toCertificate).sort((a, b) => (b.expirationDate ?? "").localeCompare(a.expirationDate ?? ""));
}

/** Makes a certificate from a signing request (the PEM text Keychain Access saves). */
export async function createCertificate(type: string, csr: string): Promise<Certificate> {
  const created = one(await post<CertificateAttributes>("/v1/certificates", { data: { type: "certificates", attributes: { certificateType: type, csrContent: csr } } }));
  if (!created) throw new ShipError("App Store Connect didn't say what certificate it made", "api-bad-response", "It may have been made anyway: `ship certificates` lists them.");
  return toCertificate(created);
}

/** Revokes a certificate: it can't sign anything again, and profiles that hold it stop working. */
export const revokeCertificate = (id: string) => del(`/v1/certificates/${encodeURIComponent(id)}`);

// MARK: Bundle ids

export interface BundleId {
  id: string;
  identifier: string;
  name: string;
  platform: string;
}

/** The bundle id record for an identifier, like com.example.lift, or undefined when the account has none. */
export async function findBundleId(identifier: string): Promise<BundleId | undefined> {
  const doc = await get<{ identifier?: string; name?: string; platform?: string }>(`/v1/bundleIds?filter[identifier]=${encodeURIComponent(identifier)}&limit=200`);
  // The filter matches prefixes too, so pick the exact one.
  const match = many(doc).find((item) => item.attributes.identifier === identifier);
  return match && { id: match.id, identifier: match.attributes.identifier ?? identifier, name: match.attributes.name ?? "", platform: match.attributes.platform ?? "" };
}

// MARK: Profiles

export interface Profile {
  id: string;
  name: string;
  /** Apple's profileType, like IOS_APP_STORE. */
  type: string;
  /** ACTIVE or INVALID (a certificate in it was revoked, or it expired). */
  state: string;
  uuid: string;
  expirationDate: string | null;
  bundleId: string | null;
  /** Made and kept up to date by Xcode's automatic signing ("iOS Team Provisioning Profile: …", "XC …"). */
  xcodeManaged: boolean;
  /** The .mobileprovision file (base64), when asked for. */
  content?: string;
}

interface ProfileAttributes {
  name?: string;
  profileType?: string;
  profileState?: string;
  uuid?: string;
  expirationDate?: string | null;
  profileContent?: string;
}

/** Whether a profile's name is one Xcode's automatic signing gives the profiles it makes. */
export const isXcodeManaged = (name: string) => /^(iOS|tvOS|Mac|Mac Catalyst|visionOS) Team (Store |Ad Hoc |Direct )?Provisioning Profile/.test(name) || name.startsWith("XC ");

function toProfile(resource: Resource<ProfileAttributes>, withContent: boolean): Profile {
  const { id, attributes } = resource;
  const name = attributes.name ?? "";
  return {
    id,
    name,
    type: attributes.profileType ?? "",
    state: attributes.profileState ?? "",
    uuid: attributes.uuid ?? "",
    expirationDate: attributes.expirationDate ?? null,
    bundleId: relationshipId(resource, "bundleId") ?? null,
    xcodeManaged: isXcodeManaged(name),
    ...(withContent && attributes.profileContent ? { content: attributes.profileContent } : {}),
  };
}

/**
 * The bundle id's profiles, by name; `withContent` also returns each
 * .mobileprovision. Only this list has them all: a profile Xcode manages is
 * listed here but can't be fetched on its own (/v1/profiles/{id} says it
 * doesn't exist), so nothing more is asked per profile.
 */
export async function bundleIdProfiles(bundleId: string, options: { withContent?: boolean } = {}): Promise<Profile[]> {
  const fields = `name,profileType,profileState,uuid,expirationDate${options.withContent ? ",profileContent" : ""}`;
  const { data } = await all<ProfileAttributes>(`/v1/bundleIds/${encodeURIComponent(bundleId)}/profiles?fields[profiles]=${fields}&limit=200`);
  return data.map((p) => toProfile({ ...p, relationships: { ...p.relationships, bundleId: { data: { type: "bundleIds", id: bundleId } } } }, Boolean(options.withContent))).sort((a, b) => a.name.localeCompare(b.name));
}

export interface NewProfile {
  name: string;
  type: string;
  bundleId: string;
  certificates: string[];
  devices: string[];
}

export function profileCreateBody(profile: NewProfile) {
  return {
    data: {
      type: "profiles",
      attributes: { name: profile.name, profileType: profile.type },
      relationships: {
        bundleId: { data: { type: "bundleIds", id: profile.bundleId } },
        certificates: { data: profile.certificates.map((id) => ({ type: "certificates", id })) },
        ...(profile.devices.length ? { devices: { data: profile.devices.map((id) => ({ type: "devices", id })) } } : {}),
      },
    },
  };
}

export async function createProfile(profile: NewProfile): Promise<Profile> {
  const created = one(await post<ProfileAttributes>("/v1/profiles", profileCreateBody(profile)));
  if (!created) throw new ShipError("App Store Connect didn't say what profile it made", "api-bad-response", "It may have been made anyway: `ship profiles` lists them.");
  return toProfile({ ...created, relationships: { bundleId: { data: { type: "bundleIds", id: profile.bundleId } }, certificates: { data: profile.certificates.map((id) => ({ type: "certificates", id })) }, devices: { data: profile.devices.map((id) => ({ type: "devices", id })) } } }, true);
}

export const deleteProfile = (id: string) => del(`/v1/profiles/${encodeURIComponent(id)}`);
