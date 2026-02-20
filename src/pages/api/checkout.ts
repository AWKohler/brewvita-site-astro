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
    modifier_catalog_object_ids?: unknown;
    quantity?: unknown;
};

type CheckoutRequestBody = {
    cart?: unknown;
    sourceId?: unknown;
    buyerEmailAddress?: unknown;
};

type NormalizedLine = {
    catalogObjectId: string;
    modifierIds: string[];
    quantity: number;
};

function jsonResponse(body: unknown, status = 200) {
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

function normalizeCartLines(rawCart: IncomingCartLine[]) {
    const grouped = new Map<string, NormalizedLine>();

    for (const line of rawCart) {
        const catalogObjectId =
            typeof line.catalog_object_id === "string"
                ? line.catalog_object_id.trim()
                : "";
        if (!catalogObjectId) continue;

        const modifierIds = Array.isArray(line.modifier_catalog_object_ids)
            ? Array.from(
                  new Set(
                      line.modifier_catalog_object_ids
                          .filter(
                              (modifierId): modifierId is string =>
                                  typeof modifierId === "string" &&
                                  modifierId.trim().length > 0,
                          )
                          .map((modifierId) => modifierId.trim()),
                  ),
              ).sort()
            : [];

        const quantity = normalizeQuantity(line.quantity);
        const key = `${catalogObjectId}::${modifierIds.join(",")}`;
        const existing = grouped.get(key);
        if (existing) {
            existing.quantity += quantity;
            continue;
        }

        grouped.set(key, {
            catalogObjectId,
            modifierIds,
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
    const activeLocation = (locationsPayload.locations || []).find(
        (location: { status?: string }) => location.status === "ACTIVE",
    );
    return activeLocation?.id || null;
}

export const POST: APIRoute = async ({ request, locals }) => {
    try {
        const body = (await request.json().catch(() => null)) as
            | CheckoutRequestBody
            | null;
        const sourceId =
            typeof body?.sourceId === "string" ? body.sourceId.trim() : "";
        if (!sourceId) {
            return jsonResponse(
                { error: "Missing payment source token." },
                400,
            );
        }

        const rawCart = Array.isArray(body?.cart)
            ? (body?.cart as IncomingCartLine[])
            : [];
        const normalizedLines = normalizeCartLines(rawCart);
        if (!normalizedLines.length) {
            return jsonResponse({ error: "Cart is empty or invalid." }, 400);
        }

        const buyerEmailAddress =
            typeof body?.buyerEmailAddress === "string" &&
            body.buyerEmailAddress.trim()
                ? body.buyerEmailAddress.trim()
                : null;

        const locationId = await resolveLocationId(locals);
        if (!locationId) {
            return jsonResponse(
                { error: "No active Square location is configured." },
                500,
            );
        }

        const lineItems = normalizedLines.map((line) => ({
            catalog_object_id: line.catalogObjectId,
            quantity: String(line.quantity),
            ...(line.modifierIds.length
                ? {
                      modifiers: line.modifierIds.map((modifierId) => ({
                          catalog_object_id: modifierId,
                          quantity: "1",
                      })),
                  }
                : {}),
        }));

        const createOrderResponse = await squareRequest(
            "/v2/orders",
            locals,
            {
                method: "POST",
                body: JSON.stringify({
                    idempotency_key: crypto.randomUUID(),
                    order: {
                        location_id: locationId,
                        line_items: lineItems,
                    },
                }),
            },
        );

        const orderId = createOrderResponse?.order?.id;
        const totalMoney = createOrderResponse?.order?.total_money;
        const amount = Number(totalMoney?.amount);
        const currency =
            typeof totalMoney?.currency === "string"
                ? totalMoney.currency
                : "USD";

        if (!orderId || !Number.isFinite(amount) || amount <= 0) {
            throw new Error("Unable to determine order total for payment.");
        }

        const paymentResponse = await squareRequest(
            "/v2/payments",
            locals,
            {
                method: "POST",
                body: JSON.stringify({
                    source_id: sourceId,
                    idempotency_key: crypto.randomUUID(),
                    location_id: locationId,
                    amount_money: {
                        amount,
                        currency,
                    },
                    order_id: orderId,
                    autocomplete: true,
                    ...(buyerEmailAddress
                        ? { buyer_email_address: buyerEmailAddress }
                        : {}),
                }),
            },
        );

        return jsonResponse({
            orderId,
            paymentId: paymentResponse?.payment?.id || null,
            paymentStatus: paymentResponse?.payment?.status || null,
            receiptUrl: paymentResponse?.payment?.receipt_url || null,
            totalMoney: {
                amount,
                currency,
            },
        });
    } catch (error) {
        return jsonResponse(
            {
                error:
                    error instanceof Error
                        ? error.message
                        : "Checkout failed.",
            },
            500,
        );
    }
};
