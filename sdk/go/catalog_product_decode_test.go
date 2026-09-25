package openwa

import (
	"encoding/json"
	"testing"
)

// The gateway omits price for a catalog item that has none, and still sends a genuine 0. The two
// must decode differently, or an unpriced item reads as free.
func TestCatalogProductPriceTellsAbsentFromZero(t *testing.T) {
	var unpriced, free CatalogProduct
	if err := json.Unmarshal([]byte(`{"id":"p1","name":"A","url":"u","isAvailable":true}`), &unpriced); err != nil {
		t.Fatalf("unmarshal unpriced: %v", err)
	}
	if err := json.Unmarshal([]byte(`{"id":"p2","name":"B","url":"u","isAvailable":true,"price":0,"currency":"IDR","priceFormatted":"IDR 0.00"}`), &free); err != nil {
		t.Fatalf("unmarshal free: %v", err)
	}
	if unpriced.Price != nil {
		t.Errorf("unpriced.Price = %v, want nil", *unpriced.Price)
	}
	if free.Price == nil || *free.Price != 0 {
		t.Errorf("free.Price = %v, want a pointer to 0", free.Price)
	}
}
