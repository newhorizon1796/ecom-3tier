// Jenkins Declarative Pipeline for the 3-tier e-commerce app.
//
// Agent prerequisites (install on the Jenkins agent, or use the
// `docker`/`kubectl`/`aws`/`terraform`/`trivy` labeled agents referenced
// below):
//   - Docker Engine (agent must be able to run `docker build`)
//   - Trivy CLI (https://aquasecurity.github.io/trivy)
//   - AWS CLI v2 + kubectl 1.29+
//   - Terraform 1.9+
//
// Jenkins plugins required: Pipeline, Git, Docker Pipeline, Credentials
// Binding, AWS Steps (or just AWS CLI on PATH), Slack Notification (optional).
//
// Credentials expected in Jenkins Credentials Store:
//   - "ecr-registry-url"      (Secret text)  e.g. 123456789012.dkr.ecr.us-east-1.amazonaws.com
//   - "aws-creds"             (AWS Credentials) used for ECR login / kubectl / terraform
//   - "kubeconfig"            (Secret file)  kubeconfig for the target EKS cluster

pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
        buildDiscarder(logRotator(numToKeepStr: '20'))
    }

    parameters {
        booleanParam(name: 'DEPLOY_TO_K8S', defaultValue: true, description: 'Apply k8s manifests after a successful scan/push')
        booleanParam(name: 'RUN_TERRAFORM', defaultValue: false, description: 'Run terraform plan/apply for the target infra')
    }

    environment {
        AWS_REGION      = 'ap-south-1'
        ECR_REGISTRY    = credentials('ecr-registry-url')
        KUBE_NAMESPACE  = 'ecom'
    }

    stages {

        stage('Checkout') {
            steps {
                checkout scm
                script {
                    // Computed here, not in the top-level `environment` block:
                    // that block evaluates before this stage runs, so
                    // env.GIT_COMMIT is not reliably populated yet on every
                    // job type. Reading it straight from git avoids that.
                    env.IMAGE_TAG      = sh(script: 'git rev-parse --short HEAD', returnStdout: true).trim()
                    env.FRONTEND_IMAGE = "${env.ECR_REGISTRY}/ecom-frontend:${env.IMAGE_TAG}"
                    env.BACKEND_IMAGE  = "${env.ECR_REGISTRY}/ecom-backend:${env.IMAGE_TAG}"
                }
            }
        }

        stage('Install & Test') {
            parallel {
                stage('Backend') {
                    steps {
                        dir('backend') {
                            sh 'npm ci'
                            sh 'npm test'
                        }
                    }
                }
                stage('Frontend') {
                    steps {
                        dir('frontend') {
                            sh 'npm ci'
                            sh 'npm test'
                            sh 'npm run build'
                        }
                    }
                }
            }
        }

        stage('Terraform (infra)') {
            when { expression { return params.RUN_TERRAFORM } }
            steps {
                dir('terraform') {
                    withCredentials([usernamePassword(credentialsId: 'aws-creds',
                                     usernameVariable: 'AWS_ACCESS_KEY_ID',
                                     passwordVariable: 'AWS_SECRET_ACCESS_KEY')]) {
                        sh 'terraform init -input=false'
                        sh 'terraform validate'
                        sh 'terraform plan -input=false -out=tfplan'
                        sh 'terraform apply -input=false -auto-approve tfplan'
                    }
                }
            }
        }

        stage('Build Docker Images') {
            parallel {
                stage('Backend image') {
                    steps {
                        sh "docker build -t ${BACKEND_IMAGE} ./backend"
                    }
                }
                stage('Frontend image') {
                    steps {
                        sh "docker build -t ${FRONTEND_IMAGE} ./frontend"
                    }
                }
            }
        }

        stage('Trivy Image Scan') {
            steps {
                sh '''
                  trivy --version
                  mkdir -p trivy-reports
                '''
                script {
                    // Fail the build on HIGH/CRITICAL CVEs; still emit a
                    // human-readable + machine-readable (SARIF) report first
                    // so failures are diagnosable from build artifacts.
                    ['backend', 'frontend'].each { tier ->
                        def image = tier == 'backend' ? env.BACKEND_IMAGE : env.FRONTEND_IMAGE
                        sh """
                          trivy image --exit-code 0 --format table ${image} \
                            > trivy-reports/${tier}-report.txt
                          trivy image --exit-code 0 --format sarif ${image} \
                            > trivy-reports/${tier}-report.sarif
                          trivy image --config trivy/trivy.yaml --exit-code 1 ${image}
                        """
                    }
                }
            }
            post {
                always {
                    archiveArtifacts artifacts: 'trivy-reports/*', allowEmptyArchive: true
                }
            }
        }

        stage('Push to ECR') {
            steps {
                withCredentials([usernamePassword(credentialsId: 'aws-creds',
                                 usernameVariable: 'AWS_ACCESS_KEY_ID',
                                 passwordVariable: 'AWS_SECRET_ACCESS_KEY')]) {
                    sh '''
                      aws ecr get-login-password --region ${AWS_REGION} \
                        | docker login --username AWS --password-stdin ${ECR_REGISTRY}
                    '''
                    sh "docker push ${BACKEND_IMAGE}"
                    sh "docker push ${FRONTEND_IMAGE}"
                }
            }
        }

        stage('Deploy to Kubernetes') {
            when { expression { return params.DEPLOY_TO_K8S } }
            steps {
                // The kubeconfig authenticates via AWS's exec-credential
                // plugin (`aws eks get-token`), so kubectl needs AWS
                // credentials available too, not just the kubeconfig file.
                withCredentials([file(credentialsId: 'kubeconfig', variable: 'KUBECONFIG'),
                                 usernamePassword(credentialsId: 'aws-creds',
                                                   usernameVariable: 'AWS_ACCESS_KEY_ID',
                                                   passwordVariable: 'AWS_SECRET_ACCESS_KEY')]) {
                    sh '''
                      kubectl apply -f k8s/namespace.yaml
                      kubectl apply -f k8s/storageclass.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/configmap.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/secret.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/mongo-statefulset.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/mongo-service.yaml

                      # Image tag is templated in here rather than committed to
                      # the manifest — `kubectl apply` on a checked-in literal
                      # tag would reset the Deployment to it on every run,
                      # fighting a separate `kubectl set image` step.
                      sed "s|__BACKEND_IMAGE__|${BACKEND_IMAGE}|g" k8s/backend-deployment.yaml \
                        | kubectl apply -n ${KUBE_NAMESPACE} -f -
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/backend-service.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/backend-hpa.yaml

                      sed "s|__FRONTEND_IMAGE__|${FRONTEND_IMAGE}|g" k8s/frontend-deployment.yaml \
                        | kubectl apply -n ${KUBE_NAMESPACE} -f -
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/frontend-service.yaml
                      kubectl apply -n ${KUBE_NAMESPACE} -f k8s/ingress.yaml

                      kubectl rollout status deployment/backend -n ${KUBE_NAMESPACE} --timeout=180s
                      kubectl rollout status deployment/frontend -n ${KUBE_NAMESPACE} --timeout=180s
                    '''
                }
            }
        }
    }

    post {
        success {
            echo "Build ${env.BUILD_NUMBER} succeeded: ${BACKEND_IMAGE}, ${FRONTEND_IMAGE}"
        }
        failure {
            echo "Build ${env.BUILD_NUMBER} failed — check the Trivy report artifacts and stage logs."
        }
        always {
            sh 'docker image prune -f || true'
        }
    }
}
