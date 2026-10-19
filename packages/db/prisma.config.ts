// Prisma never creates or migrates tables: db/migrations (dbmate) owns the schema and
// prisma/schema.prisma is introspected from it with `npm run db:pull`.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.DATABASE_URL ?? 'postgres://leadmaker:leadmaker@localhost:55432/leadmaker',
  },
});
