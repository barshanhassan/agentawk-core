import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const agencyId = 7n;
  const ownerType = 'App\\Models\\Agency';

  const roles = [
    { name: 'Super User' },
    { name: 'canEditRole' },
    { name: 'new role' },
    { name: 'Agency co-owner' },
    { name: 'Bug check' },
    { name: 'ahmed' },
    { name: 'testing' }
  ];

  console.log('Seeding roles for Agency 7...');

  for (const r of roles) {
    const slug = r.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    
    await prisma.acl_roles.upsert({
      where: { 
        // This is a bit of a workaround if there's no unique constraint on name+owner
        // but for seeding we'll just create them if they don't exist by slug/owner
        id: 0n // We'll use create if not found logic via findFirst
      },
      update: {},
      create: {
        ownerable_id: agencyId,
        ownerable_type: ownerType,
        name: r.name,
        slug: slug,
        description: `Role for ${r.name}`,
        status: 'ACTIVE',
        system: false,
        admin: false,
        icon: 'fa-user-tie'
      }
    }).catch(async (e) => {
       // Fallback if upsert with ID 0 fails (which it might depending on prisma version)
       const exists = await prisma.acl_roles.findFirst({
         where: { name: r.name, ownerable_id: agencyId }
       });
       if (!exists) {
         await prisma.acl_roles.create({
           data: {
             ownerable_id: agencyId,
             ownerable_type: ownerType,
             name: r.name,
             slug: slug,
             description: `Role for ${r.name}`,
             status: 'ACTIVE',
             system: false,
             admin: false,
             icon: 'fa-user-tie'
           }
         });
         console.log(`Created role: ${r.name}`);
       } else {
         console.log(`Role already exists: ${r.name}`);
       }
    });
  }

  console.log('Done!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
