import { z } from "zod";

export const NameSchema = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/u);
export const ServiceSchema = z.string().regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/u);
export const PortSchema = z.number().int().min(1).max(65_535);
