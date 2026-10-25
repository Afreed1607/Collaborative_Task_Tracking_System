const { z } = require('zod');

const email = z.string().trim().email().max(254).transform((value) => value.toLowerCase());
const id = z.coerce.number().int().positive();

const schemas = {
  register: z.object({
    name: z.string().trim().min(2).max(100),
    email,
    password: z.string().min(8).max(72)
  }),
  login: z.object({ email, password: z.string().min(1).max(72) }),
  profile: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    avatarUrl: z.string().url().max(500).nullable().optional()
  }).refine((value) => Object.keys(value).length > 0, 'At least one profile field is required'),
  team: z.object({
    name: z.string().trim().min(2).max(100),
    description: z.string().trim().max(1000).optional()
  }),
  teamUpdate: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(1000).nullable().optional()
  }).refine((value) => Object.keys(value).length > 0, 'At least one team field is required'),
  member: z.object({ userId: id }),
  invitation: z.object({ userId: id, expiresInDays: z.coerce.number().int().min(1).max(30).default(7) }),
  invitationResponse: z.object({ action: z.enum(['accept', 'decline']) }),
  project: z.object({ name: z.string().trim().min(2).max(100), description: z.string().trim().max(1000).optional() }),
  projectUpdate: z.object({
    name: z.string().trim().min(2).max(100).optional(),
    description: z.string().trim().max(1000).nullable().optional()
  }).refine((value) => Object.keys(value).length > 0, 'At least one project field is required'),
  task: z.object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(5000).optional(),
    dueDate: z.string().datetime({ offset: true }).optional(),
    status: z.enum(['open', 'in_progress', 'completed']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    teamId: id.nullable().optional(),
    projectId: id.nullable().optional(),
    assigneeId: id.nullable().optional()
  }),
  taskUpdate: z.object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    dueDate: z.string().datetime({ offset: true }).nullable().optional(),
    status: z.enum(['open', 'in_progress', 'completed']).optional(),
    priority: z.enum(['low', 'medium', 'high']).optional(),
    teamId: id.nullable().optional(),
    projectId: id.nullable().optional(),
    assigneeId: id.nullable().optional()
  }).refine((value) => Object.keys(value).length > 0, 'At least one task field is required'),
  comment: z.object({ body: z.string().trim().min(1).max(2000) })
};

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: 'Validation failed', details: result.error.flatten().fieldErrors });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { id, schemas, validate };
