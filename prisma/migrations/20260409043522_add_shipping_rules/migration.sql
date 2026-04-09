-- CreateTable
CREATE TABLE "ShippingRule" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shop" TEXT NOT NULL,
    "weightMinGrams" INTEGER NOT NULL,
    "weightMaxGrams" INTEGER NOT NULL,
    "feeAmount" DECIMAL,
    "feePercent" DECIMAL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "published" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL
);

-- CreateIndex
CREATE INDEX "ShippingRule_shop_idx" ON "ShippingRule"("shop");

-- CreateIndex
CREATE INDEX "ShippingRule_shop_published_idx" ON "ShippingRule"("shop", "published");
