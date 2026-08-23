import type { PoolClient } from 'pg';

import { atodotrenGroupRoles } from './contract.js';

export interface ExpectedMembership {
  readonly role: string;
  readonly admin: boolean;
  readonly inherit: boolean;
  readonly set: boolean;
}

interface RoleRow {
  rolname: string;
  rolcanlogin: boolean;
  rolinherit: boolean;
  rolsuper: boolean;
  rolcreatedb: boolean;
  rolcreaterole: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

interface MembershipRow {
  member_role: string;
  granted_role: string;
  admin_option: boolean;
  inherit_option: boolean;
  set_option: boolean;
}

export async function validateRoleContract(
  client: Pick<PoolClient, 'query'>,
  loginRole: string,
  expected: ExpectedMembership,
): Promise<void> {
  const roles = await client.query<RoleRow>(
    `SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreatedb, rolcreaterole,
            rolreplication, rolbypassrls
       FROM pg_roles
      WHERE rolname = ANY($1::text[]) OR rolname = $2
      ORDER BY rolname`,
    [atodotrenGroupRoles, loginRole],
  );
  const login = roles.rows.find((role) => role.rolname === loginRole);
  const groups = roles.rows.filter((role) =>
    (atodotrenGroupRoles as readonly string[]).includes(role.rolname),
  );
  const expectedInherit = expected.inherit;
  if (
    login === undefined ||
    !login.rolcanlogin ||
    login.rolinherit !== expectedInherit ||
    login.rolsuper ||
    login.rolcreatedb ||
    login.rolcreaterole ||
    login.rolreplication ||
    login.rolbypassrls
  ) {
    throw new Error(`Login role ${loginRole} has unsafe attributes`);
  }

  const missingGroups = atodotrenGroupRoles.filter(
    (required) => !groups.some((role) => role.rolname === required),
  );
  if (missingGroups.length > 0) {
    throw new Error(`Required Atodotren group role ${missingGroups.join(', ')} is missing`);
  }
  if (
    groups.some(
      (role) =>
        role.rolcanlogin ||
        role.rolsuper ||
        role.rolcreatedb ||
        role.rolcreaterole ||
        role.rolreplication ||
        role.rolbypassrls,
    )
  ) {
    throw new Error('Required Atodotren group roles have unsafe attributes');
  }

  const direct = await client.query<MembershipRow>(
    `SELECT member_role.rolname AS member_role,
            granted_role.rolname AS granted_role,
            membership.admin_option,
            membership.inherit_option,
            membership.set_option
       FROM pg_auth_members AS membership
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = $1
      ORDER BY granted_role.rolname`,
    [loginRole],
  );
  const validDirect =
    direct.rows.length === 1 &&
    direct.rows[0]?.granted_role === expected.role &&
    direct.rows[0].admin_option === expected.admin &&
    direct.rows[0].inherit_option === expected.inherit &&
    direct.rows[0].set_option === expected.set;
  if (!validDirect) {
    throw new Error(`Login role ${loginRole} does not have its exact required membership`);
  }

  const groupParents = await client.query<MembershipRow>(
    `SELECT member_role.rolname AS member_role,
            granted_role.rolname AS granted_role,
            membership.admin_option,
            membership.inherit_option,
            membership.set_option
       FROM pg_auth_members AS membership
       JOIN pg_roles AS member_role ON member_role.oid = membership.member
       JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
      WHERE member_role.rolname = ANY($1::text[])
      ORDER BY member_role.rolname, granted_role.rolname`,
    [atodotrenGroupRoles],
  );
  if (groupParents.rows.length > 0) {
    throw new Error('Atodotren group roles must not reach any parent roles');
  }

  const reachable = await client.query<{ rolname: string }>(
    `WITH RECURSIVE reachable(roleid) AS (
       SELECT membership.roleid
         FROM pg_auth_members AS membership
         JOIN pg_roles AS member_role ON member_role.oid = membership.member
        WHERE member_role.rolname = $1
       UNION
       SELECT membership.roleid
         FROM pg_auth_members AS membership
         JOIN reachable ON reachable.roleid = membership.member
     )
     SELECT roles.rolname
       FROM reachable
       JOIN pg_roles AS roles ON roles.oid = reachable.roleid
      ORDER BY roles.rolname`,
    [loginRole],
  );
  if (reachable.rows.length !== 1 || reachable.rows[0]?.rolname !== expected.role) {
    throw new Error(`Login role ${loginRole} can reach an unexpected role`);
  }
}
