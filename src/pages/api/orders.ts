import type { APIRoute } from "astro";

export const prerender = false;

const SQUARE_VERSION = "2025-10-16";

type RuntimeLocals = {
    runtime?: {
        env?: Record<string, string | undefined>;
    };
};

type IncomingCartLine = {
    catalog_object_id?: unknown;
    modifiers?: unknown;
    modifier_catalog_object_ids?: unknown;
    quantity?: unknown;
};

type NormalizedLine = {
    catalogObjectId: string;
    modifierEntries: Array<{
        catalogObjectId: string;
        quantity: number;
    }>;
    quantity: number;
};

function createJsonResponse(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            "Content-Type": "application/json",
        },
    });
}

function normalizeQuantity(rawQuantity: unknown) {
    const parsed = Number(rawQuantity);
    if (!Number.isFinite(parsed) || parsed <= 0) return 1;
    return Math.floor(parsed);
}

function normalizeModifiers(rawLine: IncomingCartLine) {
    const grouped = new Map<string, number>();

    if (Array.isArray(rawLine.modifiers)) {
        for (const modifier of rawLine.modifiers) {
            const modifierRecord =
                modifier && typeof modifier === "object"
                    ? (modifier as Record<string, unknown>)
                    : null;
            const catalogObjectId =
                typeof modifierRecord?.catalog_object_id === "string"
                    ? modifierRecord.catalog_object_id.trim()
                    : "";
            if (!catalogObjectId) continue;
            const quantity = normalizeQuantity(modifierRecord?.quantity);
            grouped.set(
                catalogObjectId,
                (grouped.get(catalogObjectId) || 0) + quantity,
            );
        }
    }

    if (!grouped.size && Array.isArray(rawLine.modifier_catalog_object_ids)) {
        for (const modifierId of rawLine.modifier_catalog_object_ids) {
            const catalogObjectId =
                typeof modifierId === "string" ? modifierId.trim() : "";
            if (!catalogObjectId) continue;
            grouped.set(catalogObjectId, (grouped.get(catalogObjectId) || 0) + 1);
        }
    }

    return Array.from(grouped.entries())
        .map(([catalogObjectId, quantity]) => ({
            catalogObjectId,
            quantity,
        }))
        .sort((a, b) => a.catalogObjectId.localeCompare(b.catalogObjectId));
}

function normalizeCartLines(cart: IncomingCartLine[]) {
    const grouped = new Map<string, NormalizedLine>();

    for (const line of cart) {
        const catalogObjectId =
            typeof line.catalog_object_id === "string"
                ? line.catalog_object_id.trim()
                : "";
        if (!catalogObjectId) continue;

        const modifierEntries = normalizeModifiers(line);

        const quantity = normalizeQuantity(line.quantity);
        const key = `${catalogObjectId}::${modifierEntries
            .map((modifier) => `${modifier.catalogObjectId}x${modifier.quantity}`)
            .join(",")}`;
        const existing = grouped.get(key);

        if (existing) {
            existing.quantity += quantity;
            continue;
        }

        grouped.set(key, {
            catalogObjectId,
            modifierEntries,
            quantity,
        });
    }

    return Array.from(grouped.values());
}

function getEnv(locals: RuntimeLocals | undefined, key: string) {
    return locals?.runtime?.env?.[key] ?? import.meta.env[key];
}

function resolveSquareEnvironment(locals: RuntimeLocals | undefined) {
    const explicitEnvironment = (getEnv(locals, "SQUARE_ENVIRONMENT") || "")
        .toLowerCase();
    const appId =
        getEnv(locals, "SQUARE_APP_ID") ||
        getEnv(locals, "PUBLIC_SQUARE_APP_ID") ||
        "";
    const hasSandboxAppId =
        typeof appId === "string" &&
        (appId.startsWith("sandbox-") || appId.includes("sq0idb-"));
    const hasProductionAppId =
        typeof appId === "string" && appId.includes("sq0idp-");

    if (hasSandboxAppId) return "sandbox";
    if (hasProductionAppId) return "production";
    if (explicitEnvironment === "production") return "production";
    return "sandbox";
}

function getSquareApiBase(locals: RuntimeLocals | undefined) {
    return resolveSquareEnvironment(locals) === "production"
        ? "https://connect.squareup.com"
        : "https://connect.squareupsandbox.com";
}

async function squareRequest(
    path: string,
    locals: RuntimeLocals | undefined,
    init: RequestInit = {},
) {
    const squareAccessToken = getEnv(locals, "SQUARE_ACCESS_TOKEN");
    if (!squareAccessToken) {
        throw new Error("Missing SQUARE_ACCESS_TOKEN.");
    }

    const response = await fetch(`${getSquareApiBase(locals)}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${squareAccessToken}`,
            "Content-Type": "application/json",
            "Square-Version": SQUARE_VERSION,
            ...(init.headers ?? {}),
        },
    });

    const payload = await response.json();
    if (!response.ok) {
        const details =
            payload?.errors
                ?.map(
                    (error: { detail?: string; code?: string }) =>
                        error.detail || error.code,
                )
                ?.filter(Boolean)
                ?.join(", ") || `Square API error (${response.status})`;
        throw new Error(details);
    }

    return payload;
}

async function resolveLocationId(locals: RuntimeLocals | undefined) {
    const configured = getEnv(locals, "SQUARE_LOCATION_ID");
    if (configured) return configured;

    const locationsPayload = await squareRequest("/v2/locations", locals);
    const active = (locationsPayload.locations || []).find(
        (location: { status?: string }) => location.status === "ACTIVE",
    );
    return active?.id || null;
}

export const POST: APIRoute = async ({ request, locals }) => {
    try {
        const body = await request.json().catch(() => null);
        const rawCart = Array.isArray(body?.cart)
            ? (body.cart as IncomingCartLine[])
            : [];

        const normalizedLines = normalizeCartLines(rawCart);
        if (!normalizedLines.length) {
            return createJsonResponse(
                { error: "Cart is empty or invalid." },
                400,
            );
        }

        const locationId = await resolveLocationId(locals);
        if (!locationId) {
            return createJsonResponse(
                { error: "No active Square location is configured." },
                500,
            );
        }

        const lineItems = normalizedLines.map((line) => ({
            catalog_object_id: line.catalogObjectId,
            quantity: String(line.quantity),
            ...(line.modifierEntries.length
                ? {
                      modifiers: line.modifierEntries.map((modifier) => ({
                          catalog_object_id: modifier.catalogObjectId,
                          quantity: String(modifier.quantity),
                      })),
                  }
                : {}),
        }));

        const createOrderPayload = {
            idempotency_key: crypto.randomUUID(),
            order: {
                location_id: locationId,
                line_items: lineItems,
            },
        };

        const squareResponse = await squareRequest("/v2/orders", locals, {
            method: "POST",
            body: JSON.stringify(createOrderPayload),
        });

        return createJsonResponse({
            orderId: squareResponse?.order?.id || null,
            state: squareResponse?.order?.state || null,
            locationId,
            totalMoney: squareResponse?.order?.total_money || null,
            order: squareResponse?.order || null,
        });
    } catch (error) {
        return createJsonResponse(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Unable to create order.",
            },
            500,
        );
    }
};
