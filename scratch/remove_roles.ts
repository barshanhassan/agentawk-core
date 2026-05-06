import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agencyId = 7n;
  const rolesToRemove = ['ahmed', 'testing'];

  console.log(`Removing roles: ${rolesToRemove.join(', ')} for Agency 7...`);

  const result = await prisma.acl_roles.deleteMany({
    where: {
      ownerable_id: agencyId,
      ownerable_type: 'App\\Models\\Agency',
      name: { in: rolesToRemove }
    }
  });

  console.log(`Successfully removed ${result.count} roles.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
