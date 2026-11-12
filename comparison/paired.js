import { Scenario } from '../ward_calendar/model.js';
import { Engine } from '../simulation/engine.js';
import { verify } from '../simulation/audit.js';
import { patientMetrics, wardMetrics, queueArea } from '../patient_flow/metrics.js';
import { arrivals, seeds } from './random.js';
import { digest, integer, fields, Invalid } from '../scenarios/values.js';

export function vector(scenario, result) {
  const patients = patientMetrics(scenario, result);
  const wards = wardMetrics(scenario, result);
  const queue = queueArea(result);
  return {
    admitted: patients.filter(row => row.admitted).length,
    completed: patients.filter(row => row.completed).length,
    abandoned: result.counts.abandoned,
    waiting_time: queue.waiting_person_time,
    boarding_time: queue.boarding_person_time,
    care_time: patients.reduce((sum, row) => sum + row.care_time, 0),
    capacity_debt_time: wards.reduce((sum, row) => sum + row.capacity_debt_time, 0),
    displaced: patients.filter(row => row.moves > 0).length
  };
}

export function paired(leftScenario, rightScenario) {
  if (leftScenario.horizon !== rightScenario.horizon) {
    throw new Invalid('paired scenarios require same horizon');
  }
  if (digest(leftScenario.document.patients) !== digest(rightScenario.document.patients)) {
    throw new Invalid('paired scenarios require identical patient demand');
  }
  const initial = scenario => scenario.document.wards.flatMap(ward => ward.initial).sort();
  if (digest(initial(leftScenario)) !== digest(initial(rightScenario))) {
    throw new Invalid('paired scenarios require identical initial cohort');
  }
  const left = new Engine(leftScenario).run();
  const right = new Engine(rightScenario).run();
  verify(leftScenario, left);
  verify(rightScenario, right);
  const a = vector(leftScenario, left);
  const b = vector(rightScenario, right);
  const delta = Object.fromEntries(Object.keys(a).map(key => [key, b[key] - a[key]]));
  const rightPatients = new Map(patientMetrics(rightScenario, right).map(row => [row.id, row]));
  const rows = patientMetrics(leftScenario, left).map(first => {
    const last = rightPatients.get(first.id);
    return {
      patient: first.id,
      left_status: first.status,
      right_status: last.status,
      admission_change: Number(last.admitted) - Number(first.admitted),
      initial_wait_change: last.initial_wait - first.initial_wait,
      boarding_change: last.boarding_time - first.boarding_time,
      care_time_change: last.care_time - first.care_time
    };
  });
  const body = {
    left_input: leftScenario.fingerprint,
    right_input: rightScenario.fingerprint,
    left_result: left.result_digest,
    right_result: right.result_digest,
    left: a,
    right: b,
    delta,
    patients: rows,
    direction: 'right_minus_left',
    interpretation: 'paired_simulation_not_real_world_causal_estimate'
  };
  return { ...body, comparison_digest: digest(body) };
}

export function meanInterval(values) {
  if (!values.length) {
    return {
      count: 0,
      mean: null,
      variance: null,
      interval_95: null
    };
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (values.length < 2) {
    return {
      count: 1,
      mean,
      variance: null,
      interval_95: null
    };
  }
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  const critical = [null, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262,
    2.228, 2.201, 2.179, 2.160, 2.145, 2.131, 2.120, 2.110, 2.101, 2.093, 2.086,
    2.080, 2.074, 2.069, 2.064, 2.060, 2.056, 2.052, 2.048, 2.045, 2.042];
  const df = values.length - 1;
  const t = df < critical.length ? critical[df] : df <= 60 ? 2.042 : 2.000;
  const error = t * Math.sqrt(variance / values.length);
  return {
    count: values.length,
    mean,
    variance,
    interval_95: [mean - error, mean + error],
    method: 'paired_replication_student_t_conservative_critical_value'
  };
}

export function replicate(leftTemplate, rightTemplate, profile, baseSeed = 1, count = 10) {
  const seedList = seeds(baseSeed, count);
  if (leftTemplate.horizon !== rightTemplate.horizon) {
    throw new Invalid('replication horizons differ');
  }
  const runs = [];
  for (const seed of seedList) {
    const patients = arrivals(profile, leftTemplate.horizon, seed);
    const prepare = template => {
      const document = template.export();
      if (document.wards.some(ward => ward.initial.length)) {
        throw new Invalid('generated-demand experiments require empty initial occupancy');
      }
      document.patients = patients;
      return new Scenario(document);
    };
    const result = paired(prepare(leftTemplate), prepare(rightTemplate));
    runs.push({ seed, result });
  }
  const keys = Object.keys(runs[0].result.delta);
  const estimates = Object.fromEntries(keys.map(key => [key, meanInterval(runs.map(run => run.result.delta[key]))]));
  const body = {
    base_seed: baseSeed,
    replications: count,
    profile,
    runs,
    estimates,
    common_random_numbers: 'keyed_by_seed_patient_and_attribute',
    source: 'synthetic_demand',
    limitations: ['assumed_demand_distributions', 'finite_horizon_censoring', 'no_disease_group_correlated_stays']
  };
  return { ...body, experiment_digest: digest(body) };
}
