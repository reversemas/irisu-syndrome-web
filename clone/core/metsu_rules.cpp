#include "irisu/metsu_rules.hpp"

#include "irisu/floating_point.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <cstdint>
#include <stdexcept>

namespace irisu {
namespace {

// Exact float32 stores for the Metsu descent formula
// V = 0.1 + 0.03*(L%6), overridden to 0.6 at L%6==0 (except L%24==0 -> 1.0).
// The executable computes fild(L%6); fmul 0.03f; fadd 0.1f; fstp float32.
constexpr std::uint32_t metsu_descent_bits(std::uint32_t level) {
  if (level % 24U == 0U) return 0x3f800000U;  // 1.0f
  if (level % 6U == 0U) return 0x3f19999aU;   // 0.6f
  const double value = 0.1 + 0.03 * static_cast<double>(level % 6U);
  return std::bit_cast<std::uint32_t>(static_cast<float>(value));
}

}  // namespace

MetsuLevelParameters metsu_level_parameters(std::uint32_t level) {
  const ScopedFloatingPointEnvironment floating_point_environment;
  if (level == 0 || level > 99U) {
    throw std::invalid_argument("metsu level parameters exist only for 1..99");
  }
  MetsuLevelParameters result;
  result.passive_drain_unit = 0;
  result.scripted_descent_per_update = static_cast<double>(
      std::bit_cast<float>(metsu_descent_bits(level)));
  result.bubble_rise_per_update = -0.05;
  result.spawn_interval_frames = 120U - 10U * (level % 8U);
  // exI = 200 - trunc(sin(L*tau/12) * 50). The executable evaluates the sine
  // in x87 extended precision against the exact tau constant, multiplies by
  // the float32 50, and converts with truncation toward zero.
  constexpr long double tau = 0x1.921fb54442d1846ap+2L;
  const long double sine = std::sin(
      static_cast<long double>(level) * tau / 12.0L);
  const double scaled = static_cast<double>(sine * 50.0L);
  const auto wave = static_cast<std::int32_t>(scaled);  // trunc toward zero
  result.bubble_spawn_interval_frames =
      static_cast<std::uint32_t>(200 - wave);
  const auto stride = level / 25U;
  result.rot_penalty = 600 + 50 * static_cast<std::int64_t>(stride);
  result.maximum_color_id = 5U + stride;
  result.score_scale =
      std::pow(static_cast<double>(level), 0.7) *
      static_cast<double>(stride + 4U);
  result.clear_reward_unit = 120;
  return result;
}

std::int64_t metsu_score_delta(std::uint32_t level, std::uint32_t group_num,
                               std::uint32_t group_chain,
                               std::uint32_t size_slot) {
  const ScopedFloatingPointEnvironment floating_point_environment;
  const auto parameters = metsu_level_parameters(level);
  const auto factor = std::max<std::int64_t>(
      1, static_cast<std::int64_t>(size_slot) - 4);
  double exact = static_cast<double>(group_num);
  exact *= 0.5;
  exact += 0.5;
  exact *= static_cast<double>(group_chain);
  exact *= parameters.score_scale;
  exact *= static_cast<double>(factor);
  if (!std::isfinite(exact) || exact >= 0x1p63) {
    throw std::overflow_error("metsu score delta overflow");
  }
  return static_cast<std::int64_t>(exact);
}

}  // namespace irisu
