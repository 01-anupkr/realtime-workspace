import { describe, expect, it } from "vitest";
import { boardRoom, syncBoardRoom } from "./socketRooms.js";

type MockSocket = {
  rooms: Set<string>;
  data: { currentBoardRoom?: string | null };
  leave: (room: string) => Promise<void>;
  join: (room: string) => Promise<void>;
};

describe("board room synchronization", () => {
  it("uses the workspace and board room key consistently", () => {
    expect(boardRoom("workspace-1", "board-2")).toBe("workspace:workspace-1:board:board-2");
  });

  it("leaves the previous board room before joining the new board", async () => {
    const rooms = new Set(["user:user-1", "workspace:workspace-1:board:board-1"]);
    const socket: MockSocket = {
      rooms,
      data: { currentBoardRoom: "workspace:workspace-1:board:board-1" },
      leave: async (room: string) => {
        rooms.delete(room);
      },
      join: async (room: string) => {
        rooms.add(room);
      },
    };

    await syncBoardRoom(socket, "workspace-1", "board-2");

    expect(rooms.has("workspace:workspace-1:board:board-1")).toBe(false);
    expect(rooms.has("workspace:workspace-1:board:board-2")).toBe(true);
    expect(socket.data.currentBoardRoom).toBe("workspace:workspace-1:board:board-2");
  });
});
