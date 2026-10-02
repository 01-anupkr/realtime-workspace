import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";
import { generateKeyBetween } from "fractional-indexing";

const password = process.env.DEMO_ACCOUNT_PASSWORD;
if (!password || password.length < 12) {
  throw new Error("Set DEMO_ACCOUNT_PASSWORD to a value of at least 12 characters before seeding");
}

const prisma = new PrismaClient();
const passwordHash = await bcrypt.hash(password, 12);

try {
  await prisma.$transaction(async (tx) => {
    const owner = await tx.user.upsert({
      where: { email: "owner.demo@example.com" },
      update: {},
      create: { name: "Demo Owner", email: "owner.demo@example.com", passwordHash },
    });
    const member = await tx.user.upsert({
      where: { email: "member.demo@example.com" },
      update: {},
      create: { name: "Demo Member", email: "member.demo@example.com", passwordHash },
    });
    let workspace = await tx.workspace.findFirst({ where: { name: "Commonplace Demo" }, orderBy: { createdAt: "asc" } });
    if (!workspace) workspace = await tx.workspace.create({ data: { name: "Commonplace Demo" } });
    await tx.membership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: owner.id } },
      update: { role: "OWNER" },
      create: { workspaceId: workspace.id, userId: owner.id, role: "OWNER" },
    });
    await tx.membership.upsert({
      where: { workspaceId_userId: { workspaceId: workspace.id, userId: member.id } },
      update: { role: "MEMBER" },
      create: { workspaceId: workspace.id, userId: member.id, role: "MEMBER" },
    });
    let board = await tx.board.findFirst({ where: { workspaceId: workspace.id, name: "Product board" } });
    if (!board) board = await tx.board.create({ data: { workspaceId: workspace.id, name: "Product board" } });

    let previousRank = null;
    for (const title of ["To do", "In progress", "Done"]) {
      let list = await tx.taskList.findFirst({ where: { workspaceId: workspace.id, boardId: board.id, title } });
      if (!list) {
        previousRank = generateKeyBetween(previousRank, null);
        list = await tx.taskList.create({ data: { workspaceId: workspace.id, boardId: board.id, title, rank: previousRank } });
      }
      previousRank = list.rank;
      const sampleTask = {
        "To do": { title: "Align on workspace goals", description: "Capture the outcomes this team wants to reach.", status: "TODO", label: "Planning" },
        "In progress": { title: "Prepare the first sprint", description: "Turn the initial roadmap into a focused sprint.", status: "IN_PROGRESS", label: "Delivery" },
        "Done": { title: "Review the onboarding checklist", description: "Confirm the team can get started smoothly.", status: "DONE", label: "Operations" },
      }[title];
      if (!(await tx.task.findFirst({ where: { workspaceId: workspace.id, listId: list.id, title: sampleTask.title } }))) {
        const lastTask = await tx.task.findFirst({ where: { workspaceId: workspace.id, listId: list.id }, orderBy: { rank: "desc" }, select: { rank: true } });
        await tx.task.create({ data: { ...sampleTask, workspaceId: workspace.id, listId: list.id, rank: generateKeyBetween(lastTask?.rank ?? null, null) } });
      }
    }
  });
  console.info("Demo accounts and board are ready");
} finally {
  await prisma.$disconnect();
}
