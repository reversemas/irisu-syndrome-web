#include "irisu/config.hpp"
#include "irisu/metsu_rules.hpp"
#include "irisu/simulator.hpp"

#ifdef NDEBUG
#undef NDEBUG
#endif
#include <cassert>
#include <cmath>
#include <cstdint>
#include <iostream>
#include <limits>
#include <vector>

namespace {

void metsu_level_table_matches_the_recovered_setter() {
  // Spot values recovered from the 0x415800 table.
  const auto level1 = irisu::metsu_level_parameters(1);
  assert(level1.passive_drain_unit == 0);
  assert(std::abs(level1.scripted_descent_per_update - 0.13) < 1e-6);
  assert(level1.bubble_rise_per_update == -0.05);
  assert(level1.spawn_interval_frames == 110);
  assert(level1.bubble_spawn_interval_frames == 175);
  assert(level1.rot_penalty == 600);
  assert(level1.maximum_color_id == 5);
  assert(level1.clear_reward_unit == 120);
  assert(std::abs(level1.score_scale - 4.0 * std::pow(1.0, 0.7)) < 1e-12);

  const auto level6 = irisu::metsu_level_parameters(6);
  assert(level6.scripted_descent_per_update == 0.6F);

  const auto level24 = irisu::metsu_level_parameters(24);
  assert(level24.scripted_descent_per_update == 1.0F);

  const auto level7 = irisu::metsu_level_parameters(7);
  assert(std::abs(level7.scripted_descent_per_update - 0.13) < 1e-6);
  assert(level7.spawn_interval_frames == 50);

  const auto level13 = irisu::metsu_level_parameters(13);
  assert(level13.spawn_interval_frames == 70);
  assert(std::abs(level13.scripted_descent_per_update - 0.13) < 1e-6);

  const auto level2 = irisu::metsu_level_parameters(2);
  assert(std::abs(level2.scripted_descent_per_update - 0.16) < 1e-6);
  const auto level5 = irisu::metsu_level_parameters(5);
  assert(std::abs(level5.scripted_descent_per_update - 0.25) < 1e-6);

  const auto level25 = irisu::metsu_level_parameters(25);
  assert(level25.maximum_color_id == 6);
  assert(level25.rot_penalty == 650);
  assert(std::abs(level25.score_scale -
                  std::pow(25.0, 0.7) * 5.0) < 1e-9);

  // exI = 200 - trunc(sin(L*tau/12)*50) oscillates with a 12-level period:
  // L=3 -> 150, L=6 -> 200, L=9 -> 250.
  assert(irisu::metsu_level_parameters(3).bubble_spawn_interval_frames == 150);
  assert(irisu::metsu_level_parameters(6).bubble_spawn_interval_frames == 200);
  assert(irisu::metsu_level_parameters(9).bubble_spawn_interval_frames == 250);
  assert(irisu::metsu_level_parameters(12).bubble_spawn_interval_frames == 200);

  bool threw = false;
  try { (void)irisu::metsu_level_parameters(0); } catch (...) { threw = true; }
  assert(threw);
  threw = false;
  try { (void)irisu::metsu_level_parameters(100); } catch (...) { threw = true; }
  assert(threw);
}

void metsu_score_delta_uses_the_shared_burst_formula() {
  // Level 1: S = 4, so (0.5*num + 0.5) * chain * 4 * 1.
  assert(irisu::metsu_score_delta(1, 1, 2, 0) == 8);
  assert(irisu::metsu_score_delta(1, 2, 2, 2) == 12);
  // Slots beyond 4 keep the normal factor of slot-4.
  assert(irisu::metsu_score_delta(1, 1, 1, 5) == 4);
}

void metsu_reset_uses_the_ini_profile() {
  irisu::Simulator simulator{irisu::metsu_default_config()};
  const auto observation = simulator.reset(12345);
  assert(observation.field_x == 94.0);
  assert(observation.field_y == 20.0);
  assert(observation.field_width == 420.0);
  assert(observation.field_height == 370.0);
  assert(observation.gauge == 1000);
  assert(observation.gauge_max == 10000);
  assert(observation.level == 1);
  assert(observation.active_colors == 6);
  assert(observation.current_spawn_interval_ticks == 110);
  // The metsu prefill spawns only the ten scripted falling squares: no rotten
  // physics-owned actors are created.
  std::size_t falling = 0;
  for (const auto& body : observation.bodies) {
    assert(body.lifecycle == irisu::Lifecycle::ScriptedFalling);
    assert(!body.bubble);
    ++falling;
  }
  assert(falling <= 10);
}

void metsu_spawns_and_raises_bubbles() {
  irisu::Simulator simulator{irisu::metsu_default_config()};
  simulator.reset(777);
  bool saw_bubble = false;
  double highest_bubble_y = 1000.0;
  for (int index = 0; index < 4000; ++index) {
    (void)simulator.step({irisu::ActionKind::Wait, 0, 0, 1});
    const auto observation = simulator.observation();
    for (const auto& body : observation.bodies) {
      if (!body.bubble) continue;
      saw_bubble = true;
      if (body.pop_countdown < 0 && body.remaining_lifetime < 0) {
        highest_bubble_y = std::min(highest_bubble_y, body.position.y);
      }
    }
  }
  assert(saw_bubble);
  // Bubbles spawn at y=500 and the scripted -0.05/update rise lifts them;
  // contacts with squares usually schedule them first, so only require the
  // observable rise rather than a full board crossing.
  assert(highest_bubble_y < 498.0);
  // Bubbles only roll the reachable 42/58/74 sizes because the executable
  // draws the bubble ticket over the square-table total.
  const auto observation = simulator.observation();
  for (const auto& body : observation.bodies) {
    if (body.bubble) {
      assert(body.size == 42.0 || body.size == 58.0 || body.size == 74.0);
      assert(body.shape == irisu::Shape::Circle);
    }
  }
}

void metsu_config_hash_differs_from_normal() {
  irisu::Simulator normal{irisu::MechanicsConfig{}};
  irisu::Simulator metsu{irisu::metsu_default_config()};
  assert(normal.config_hash() != metsu.config_hash());
}

void normal_mode_is_untouched_by_the_metsu_profile() {
  // The default config must stay exactly the mode-0 profile.
  const irisu::MechanicsConfig defaults;
  assert(!defaults.metsu_mode);
  assert(defaults.field_x == 130.0);
  assert(defaults.gauge_max == 40000);
  assert(defaults.qualifying_clears_per_level == 10);
  irisu::Simulator simulator;
  const auto observation = simulator.reset(41);
  assert(observation.field_x == 130.0);
  assert(observation.gauge == 3000);
}

}  // namespace

int main() {
  metsu_level_table_matches_the_recovered_setter();
  metsu_score_delta_uses_the_shared_burst_formula();
  metsu_reset_uses_the_ini_profile();
  metsu_spawns_and_raises_bubbles();
  metsu_config_hash_differs_from_normal();
  normal_mode_is_untouched_by_the_metsu_profile();
  std::cout << "metsu rules tests passed\n";
  return 0;
}
