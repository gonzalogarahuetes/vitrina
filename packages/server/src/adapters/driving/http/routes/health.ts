import Fastify from "fastify";

const options = {
  schema: {
    response: {
      200: {
        type: "number",
      },
    },
  },
};

Fastify.get("/health", options, (request, reply) => {
  reply.send(200);
});
