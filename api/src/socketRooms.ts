type BoardSocket = {
  data?: { currentBoardRoom?: string | null };
  leave?: (room: string) => Promise<void> | void;
  join?: (room: string) => Promise<void> | void;
};

export function boardRoom(workspaceId: string, boardId: string): string {
  return `workspace:${workspaceId}:board:${boardId}`;
}

export async function syncBoardRoom(socket: BoardSocket, workspaceId: string, boardId: string): Promise<string> {
  const nextRoom = boardRoom(workspaceId, boardId);
  const previousRoom = socket.data?.currentBoardRoom;

  if (previousRoom && previousRoom !== nextRoom) {
    await socket.leave?.(previousRoom);
  }

  if (previousRoom !== nextRoom) {
    await socket.join?.(nextRoom);
  }

  if (socket.data) {
    socket.data.currentBoardRoom = nextRoom;
  }

  return nextRoom;
}
