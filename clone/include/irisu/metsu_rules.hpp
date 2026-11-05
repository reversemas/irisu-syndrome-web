#pragma once

#include <cstdint>

namespace irisu {

// Recovered from the Metsu level setter at 0x415800 (selected by 0x415600 when
// the metsu flag is nonzero). All values are per active parameter level.
struct MetsuLevelParameters {
  std::uint32_t passive_drain_unit{};      // always 0: no passive life drain
  double scripted_descent_per_update{};    // V, float32 store
  double bubble_rise_per_update{};         // ex_block_speed, -0.05
  std::uint32_t spawn_interval_frames{};   // I = 120 - 10*(L%8)
  std::uint32_t bubble_spawn_interval_frames{};  // exI = 200 - trunc(sin(L*tau/12)*50)
  std::int64_t rot_penalty{};              // P = 600 + 50*trunc(L/25)
  std::uint32_t maximum_color_id{};        // C = 5 + trunc(L/25), inclusive
  double score_scale{};                    // S = pow(L,0.7) * (trunc(L/25)+4)
  std::int64_t clear_reward_unit{};        // game_life_plus_unit, 120
};

// Exists for levels 1..99. Level 100 requests bypass the setter exactly like
// normal mode.
MetsuLevelParameters metsu_level_parameters(std::uint32_t level);

// Same x87 scoring shape as normal mode with the Metsu score scale. The size
// slot factor stays max(1, slot-4); Metsu tables only use slots 0..5.
std::int64_t metsu_score_delta(std::uint32_t level, std::uint32_t group_num,
                               std::uint32_t group_chain,
                               std::uint32_t size_slot);

}  // namespace irisu
