from datetime import date
import pytest
from app.modules.analysis.scoring.calculator import weighted_power_mean, related_months, qualifications, calculate
from app.modules.analysis.models import ParsedResume, ParsedJob
from app.modules.analysis.scoring.rubric import CRITERIA


def resume(careers=None, **kwargs):
    return ParsedResume(skills=[], careers=careers or [], explicit_no_employment=False, no_employment_evidence=[], education=[], projects=[], **kwargs)


def job(**kwargs):
    return ParsedJob(title='job', company_name='company', responsibilities=[], technical_requirements=[], preferred_requirements=[], other_required_conditions=[],
                     career_min_months=kwargs.get('months'), education_level=None, required_major=None, conditions_evidence=[])


def test_square_root_power_mean_reference_and_weight_normalization():
    # ((sqrt(25) + sqrt(100)) / 2)^2 = 56.25.
    assert weighted_power_mean([(25, 1, 'met'), (100, 1, 'met')]) == pytest.approx(56.25)
    # Relative weights 1:3: ((5 + 3*10) / 4)^2 = 76.5625.
    assert weighted_power_mean([(25, 1, 'met'), (100, 3, 'met')]) == pytest.approx(76.5625)
    assert weighted_power_mean([(25, .25, 'met'), (100, .75, 'met')]) == pytest.approx(76.5625)


def test_zero_contributes_by_weight_without_annihilating_other_scores():
    assert weighted_power_mean([(0, 1, 'not_met'), (100, 1, 'met')]) == pytest.approx(25)
    assert weighted_power_mean([(0, 1, 'not_met'), (100, 3, 'met')]) == pytest.approx(56.25)
    assert weighted_power_mean([(0, 1, 'not_met'), (0, 1, 'not_met')]) == 0


@pytest.mark.parametrize('items', [
    [], [(None, 1, 'unknown')], [(None, 1, 'not_applicable')],
    [(-1, 1, 'not_met')], [(101, 1, 'met')], [(float('nan'), 1, 'met')],
    [(float('inf'), 1, 'met')], [(50, 0, 'met')], [(50, -1, 'met')],
    [(50, float('nan'), 'met')], [(50, float('inf'), 'met')],
])
def test_missing_or_invalid_scores_and_weights_are_rejected(items):
    with pytest.raises(ValueError):
        weighted_power_mean(items)


def test_overlapping_careers_and_education_project():
    careers = [dict(start='2024-01',end='2024-12',related=True,kind='employment',evidence=[]),
               dict(start='2024-07',end='2025-06',related=True,kind='employment',evidence=[]),
               dict(start='2023-01',end='2023-12',related=True,kind='education_project',evidence=[])]
    assert related_months(resume(careers), date(2026,10,8)) == 18


def test_missing_employment_evidence_and_explicit_none_both_score_zero():
    r = resume()
    missing = qualifications('C1', r, job(months=24), date(2026,10,8))
    assert (missing.score, missing.verdict) == (0, 'not_met')
    r.explicit_no_employment = True
    r.no_employment_evidence = [{'source': 'resume', 'quote': '경력 없음'}]
    explicit = qualifications('C1', r, job(months=24), date(2026,10,8))
    assert (explicit.score, explicit.verdict) == (0, 'not_met')


@pytest.mark.parametrize('code', ['C1', 'C2', 'C3'])
def test_absent_job_requirement_is_fully_met(code):
    result = qualifications(code, resume(), job(), date(2026,10,8))
    assert (result.score, result.verdict) == (100, 'met')


def test_complete_equal_criteria_preserve_their_score():
    criteria = {code: {'score': 80, 'verdict': 'met', 'issues': []} for code, *_ in CRITERIA}
    scores = calculate(criteria)
    for domain in ['resume_completeness', 'job_fit', 'qualifications', 'practical_competitiveness', 'overall_score']:
        assert scores[domain] == pytest.approx(80)
    assert scores['eligibility_status'] == 'met'
    assert scores['validation_status'] == 'passed'


def test_missing_criterion_rejected():
    with pytest.raises(ValueError): calculate({})


def test_invalid_future_career():
    r = resume([dict(start='2027-01',end='2027-03',related=True,kind='employment',evidence=[])])
    with pytest.raises(ValueError): related_months(r,date(2026,10,8))
