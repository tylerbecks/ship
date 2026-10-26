// The team in App Store Connect: users, and the invitations not accepted yet.

import { type Resource, all, del, one, post } from "./client";

/** Apple's user roles (UserRole). */
export const USER_ROLES = [
  "ADMIN",
  "APP_MANAGER",
  "DEVELOPER",
  "MARKETING",
  "SALES",
  "FINANCE",
  "ACCESS_TO_REPORTS",
  "CUSTOMER_SUPPORT",
  "CREATE_APPS",
  "CLOUD_MANAGED_DEVELOPER_ID",
  "CLOUD_MANAGED_APP_DISTRIBUTION",
  "GENERATE_INDIVIDUAL_KEYS",
] as const;

export type UserRole = (typeof USER_ROLES)[number] | "ACCOUNT_HOLDER";

/** A user, or an invitation (`invited`) not accepted yet. */
export interface TeamMember {
  id: string;
  /** The Apple Account email. */
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  allAppsVisible: boolean;
  /** The apps they see, when not all of them. */
  visibleApps: string[];
  provisioningAllowed: boolean;
  invited: boolean;
  /** When an invitation lapses. */
  expirationDate: string | null;
}

interface MemberAttributes {
  username?: string;
  email?: string;
  firstName?: string | null;
  lastName?: string | null;
  roles?: string[];
  allAppsVisible?: boolean;
  provisioningAllowed?: boolean;
  expirationDate?: string | null;
}

export function toMember(resource: Resource<MemberAttributes>, invited: boolean): TeamMember {
  const { attributes } = resource;
  const apps = resource.relationships?.visibleApps?.data;
  return {
    id: resource.id,
    email: attributes.username ?? attributes.email ?? "",
    firstName: attributes.firstName ?? "",
    lastName: attributes.lastName ?? "",
    roles: attributes.roles ?? [],
    allAppsVisible: attributes.allAppsVisible ?? false,
    visibleApps: Array.isArray(apps) ? apps.map((app) => app.id) : [],
    provisioningAllowed: attributes.provisioningAllowed ?? false,
    invited,
    expirationDate: attributes.expirationDate ?? null,
  };
}

/** Everyone on the team, then the invitations, by email. */
export async function teamMembers(): Promise<TeamMember[]> {
  const [users, invitations] = await Promise.all([
    all<MemberAttributes>("/v1/users?include=visibleApps&limit=200&limit[visibleApps]=50"),
    all<MemberAttributes>("/v1/userInvitations?include=visibleApps&limit=200&limit[visibleApps]=50"),
  ]);
  const byEmail = (a: TeamMember, b: TeamMember) => a.email.localeCompare(b.email);
  return [...users.data.map((user) => toMember(user, false)).sort(byEmail), ...invitations.data.map((invite) => toMember(invite, true)).sort(byEmail)];
}

export interface Invitation {
  email: string;
  firstName: string;
  lastName: string;
  roles: string[];
  /** Every app, or only `visibleApps` (App Store Connect ids). */
  allAppsVisible: boolean;
  visibleApps: string[];
  provisioningAllowed: boolean;
}

/** The body that invites someone. */
export function invitationBody(invite: Invitation) {
  return {
    data: {
      type: "userInvitations",
      attributes: {
        email: invite.email,
        firstName: invite.firstName,
        lastName: invite.lastName,
        roles: invite.roles,
        allAppsVisible: invite.allAppsVisible,
        provisioningAllowed: invite.provisioningAllowed,
      },
      ...(invite.allAppsVisible ? {} : { relationships: { visibleApps: { data: invite.visibleApps.map((id) => ({ type: "apps", id })) } } }),
    },
  };
}

/** Invites someone; Apple emails them. */
export async function inviteUser(invite: Invitation): Promise<TeamMember> {
  const created = one(await post<MemberAttributes>("/v1/userInvitations", invitationBody(invite)));
  return created ? toMember(created, true) : { id: "", ...invite, invited: true, expirationDate: null };
}

/** Takes someone off the team, or cancels their invitation. */
export const removeMember = (member: Pick<TeamMember, "id" | "invited">) =>
  del(`/v1/${member.invited ? "userInvitations" : "users"}/${encodeURIComponent(member.id)}`);
