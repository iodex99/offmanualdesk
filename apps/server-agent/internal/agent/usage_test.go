package agent

import (
	"context"
	"testing"

	"offmanual/desk/server-agent/internal/rpc"
)

func TestUsageAdd(t *testing.T) {
	e := newEnv(t)
	ctx := context.Background()
	add := func(c rpc.Caller, turns, in, out int64) map[string]any {
		_, errObj := e.call(c, "usage.add", map[string]int64{"turns": turns, "inputTokens": in, "outputTokens": out})
		return errObj
	}
	if errObj := add(asha, 2, 1500, 300); errObj != nil {
		t.Fatal(errObj)
	}
	if errObj := add(asha, 1, 500, 100); errObj != nil {
		t.Fatal(errObj)
	}
	rows, err := e.st.UsageForDate(ctx, "2026-11-23") // env clock is 09:30 IST on 23-11-2026
	if err != nil || len(rows) != 1 || rows[0].Turns != 3 || rows[0].InputTokens != 2000 || rows[0].OutputTokens != 400 {
		t.Fatalf("rows %+v %v", rows, err)
	}
	for _, bad := range [][3]int64{{-1, 0, 0}, {maxTurnsPerCall + 1, 0, 0}, {0, -5, 0}, {0, 0, maxTokensPerCall + 1}} {
		if errObj := add(asha, bad[0], bad[1], bad[2]); code(errObj) != rpc.CodeInvalidParams {
			t.Fatalf("accepted %v", bad)
		}
	}
	if _, errObj := e.call(asha, "usage.add", map[string]int64{"turns": 1}); code(errObj) != rpc.CodeInvalidParams {
		t.Fatal("missing fields accepted")
	}
	if errObj := add(nobod, 1, 1, 1); errObj == nil {
		t.Fatal("unknown caller recorded usage")
	}
}
