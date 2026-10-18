"use server";

import { prisma } from "@/server/db/client";
import { requireCurrentUser } from "@/server/auth/session";
import { createOrganizationSchema } from "@/lib/validation/organization";
import { slugify } from "@/lib/slug";

export type CreateOrganizationResult =
  | { ok: true; slug: string }
  | { ok: false; error: string };

async function uniqueSlugFor(baseName: string): Promise<string> {
  const base = slugify(baseName) || "workspace";
  let candidate = base;
  let suffix = 1;

  while (await prisma.organization.findUnique({ where: { slug: candidate } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  return candidate;
}

export async function createOrganization(formData: FormData): Promise<CreateOrganizationResult> {
  const user = await requireCurrentUser();

  const parsed = createOrganizationSchema.safeParse({
    name: formData.get("name"),
  });

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
  }

  const slug = await uniqueSlugFor(parsed.data.name);

  await prisma.$transaction(async (tx) => {
    const organization = await tx.organization.create({
      data: { name: parsed.data.name, slug },
    });

    await tx.membership.create({
      data: {
        userId: user.id,
        organizationId: organization.id,
        role: "OWNER",
      },
    });

    await tx.auditLog.create({
      data: {
        organizationId: organization.id,
        actorUserId: user.id,
        action: "org.created",
        metadata: { name: organization.name },
      },
    });
  });

  return { ok: true, slug };
}
