import { prisma } from "@/server/db/client";

export async function resetDatabase() {
  await prisma.auditLog.deleteMany();
  await prisma.membership.deleteMany();
  await prisma.session.deleteMany();
  await prisma.account.deleteMany();
  await prisma.organization.deleteMany();
  await prisma.user.deleteMany();
}
