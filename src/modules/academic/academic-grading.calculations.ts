export const ACADEMIC_AVERAGE_SCALE = 20;

export type WeightedEvaluationGrade = {
  score: number;
  maxScore: number;
  coefficient: number;
};

export type WeightedSubjectAverage = {
  average: number | null;
  coefficient: number;
};

const roundAverage = (value: number): number => Math.round(value * 1000) / 1000;

export const calculateSubjectAverage = (
  grades: readonly WeightedEvaluationGrade[]
): number | null => {
  if (grades.length === 0) {
    return null;
  }

  let weightedTotal = 0;
  let coefficientTotal = 0;

  for (const grade of grades) {
    if (grade.maxScore <= 0 || grade.coefficient <= 0) {
      throw new Error('Grade max score and coefficient must be positive');
    }
    if (grade.score < 0 || grade.score > grade.maxScore) {
      throw new Error('Grade score must be between zero and max score');
    }

    const normalizedScore = (grade.score / grade.maxScore) * ACADEMIC_AVERAGE_SCALE;
    weightedTotal += normalizedScore * grade.coefficient;
    coefficientTotal += grade.coefficient;
  }

  return roundAverage(weightedTotal / coefficientTotal);
};

export const calculateGeneralAverage = (
  subjects: readonly WeightedSubjectAverage[]
): number | null => {
  const gradedSubjects = subjects.filter(
    (subject): subject is { average: number; coefficient: number } =>
      subject.average !== null
  );

  if (gradedSubjects.length === 0) {
    return null;
  }

  let weightedTotal = 0;
  let coefficientTotal = 0;

  for (const subject of gradedSubjects) {
    if (subject.coefficient <= 0) {
      throw new Error('Subject coefficient must be positive');
    }
    weightedTotal += subject.average * subject.coefficient;
    coefficientTotal += subject.coefficient;
  }

  return roundAverage(weightedTotal / coefficientTotal);
};
