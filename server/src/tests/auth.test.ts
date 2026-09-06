import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../app.js";

describe("POST /auth/register", () => {
  it("registers a new user and sets an auth cookie", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "newuser@test.com", password: "password123" });

    expect(res.status).toBe(201);
    expect(res.body.user.email).toBe("newuser@test.com");
    expect(res.headers["set-cookie"]).toBeDefined();
    expect(res.headers["set-cookie"]![0]).toMatch(/token=/);
  });

  it("rejects a duplicate email", async () => {
    await request(app)
      .post("/auth/register")
      .send({ email: "dupe@test.com", password: "password123" });

    const res = await request(app)
      .post("/auth/register")
      .send({ email: "dupe@test.com", password: "password123" });

    expect(res.status).toBe(409);
  });

  it("rejects a password under 8 characters", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "shortpass@test.com", password: "abc" });

    expect(res.status).toBe(400);
  });

  it("rejects an invalid email format", async () => {
    const res = await request(app)
      .post("/auth/register")
      .send({ email: "not-an-email", password: "password123" });

    expect(res.status).toBe(400);
  });
});

describe("POST /auth/login", () => {
  it("logs in with correct credentials", async () => {
    await request(app)
      .post("/auth/register")
      .send({ email: "logintest@test.com", password: "password123" });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "logintest@test.com", password: "password123" });

    expect(res.status).toBe(200);
    expect(res.headers["set-cookie"]![0]).toMatch(/token=/);
  });

  it("rejects a wrong password", async () => {
    await request(app)
      .post("/auth/register")
      .send({ email: "wrongpass@test.com", password: "password123" });

    const res = await request(app)
      .post("/auth/login")
      .send({ email: "wrongpass@test.com", password: "wrongpassword" });

    expect(res.status).toBe(401);
  });

  it("rejects a nonexistent user", async () => {
    const res = await request(app)
      .post("/auth/login")
      .send({ email: "doesnotexist@test.com", password: "password123" });

    expect(res.status).toBe(401);
  });
});