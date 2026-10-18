import NextAuth, { AuthError } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { PrismaAdapter } from "@auth/prisma-adapter";

import { prisma } from "@/server/db/client";
import { verifyPassword } from "@/lib/password";
import { signInSchema } from "@/lib/validation/auth";

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in" },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (rawCredentials) => {
        const parsed = signInSchema.safeParse(rawCredentials);
        if (!parsed.success) {
          return null;
        }

        const user = await prisma.user.findUnique({
          where: { email: parsed.data.email },
        });

        if (!user?.passwordHash) {
          return null;
        }

        const passwordIsValid = await verifyPassword(parsed.data.password, user.passwordHash);
        if (!passwordIsValid) {
          return null;
        }

        return { id: user.id, email: user.email, name: user.name };
      },
    }),
  ],
  callbacks: {
    jwt: async ({ token, user }) => {
      if (user?.id) {
        token.sub = user.id;
      }
      return token;
    },
    session: async ({ session, token }) => {
      if (session.user && token.sub) {
        session.user.id = token.sub;
      }
      return session;
    },
  },
});

export { AuthError };
